# hm-radio-simulator

[:de: Deutsches README](README.md)

[![CI](https://github.com/hobbyquaker/hm-radio-simulator/actions/workflows/ci.yml/badge.svg)](https://github.com/hobbyquaker/hm-radio-simulator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A simulated Homematic **radio module** and a **test suite for the CCU's radio daemons** - `rfd` and `hs485d` of
[OpenCCU-Base](https://github.com/OpenCCU/OpenCCU-Base), later `multimacd`.

[hm-simulator](https://github.com/hobbyquaker/hm-simulator) plays the CCU's interface processes towards their
clients. This project points the other way: it plays the **hardware** towards the real daemons - the RPI-RF-MOD /
HM-MOD-RPI-PCB on a serial line, the HM-LGW over TCP, the HMW-LGW over TCP - so that the daemons can be started,
exercised and broken in a container, in CI, without a radio module in the room. The daemons are built from
OpenCCU-Base at a chosen ref inside the docker image; nothing of theirs is copied here.

**Status:** stage 0 (the image, RPC black-box tests, libFuzzer harnesses) and stage 1a (the simulated module on a
pty: rfd's init to `CONNECTED`, module lost, frame fuzzing) exist. See _Stages_ for what follows.

## What it tests

| Test file                                | What                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/daemon/rfd-rpc.test.js`            | rfd's RPC surface: method list over BIN-RPC and XML-RPC on the same port, `listDevices`, `listBidcosInterfaces`, `init` registers a receiver and rfd calls `listDevices`/`newDevices` on it; and the measurement that rfd 3.89.11 does not start without a configured interface ("No BidCoS-Interface available"), which is why these tests run with the simulated module too |
| `test/daemon/rfd-rpc-robustness.test.js` | OpenCCU-Base [#138](https://github.com/OpenCCU/OpenCCU-Base/pull/138) nested `system.multicall`, [#140](https://github.com/OpenCCU/OpenCCU-Base/pull/140) malformed BIN-RPC, hostile XML-RPC, [#27](https://github.com/OpenCCU/OpenCCU-Base/pull/27) a receiver that disappears                                                                                               |
| `test/daemon/hs485d-rpc.test.js`         | hs485d against a silent TCP bus: method list, `listDevices`, #138 and #140 on hs485d                                                                                                                                                                                                                                                                                          |
| `test/daemon/rfd-pty-module.test.js`     | the simulated module on a pty: rfd's init sequence and `CONNECTED`; the module in the bootloader; a `BUSY` retry; module lost ([#115](https://github.com/OpenCCU/OpenCCU-Base/pull/115), [#116](https://github.com/OpenCCU/OpenCCU-Base/pull/116)); module back; events; frame fuzzing                                                                                        |
| `fuzz/`                                  | libFuzzer harnesses for `XmlRpcValue` (BIN-RPC and XML deserializers), the request dispatcher with `system.multicall`, and `xmlParser`                                                                                                                                                                                                                                        |
| `test/unit/`                             | the simulator itself: framing and CRC, the module state machine, the raw BIN-RPC encoder                                                                                                                                                                                                                                                                                      |

A regression test for a bug the chosen OpenCCU-Base ref does not have the fix for runs as `todo` (`HMRS_KNOWN_BROKEN`,
set per ref by the Dockerfile), so the run shows what happens without going red. Against `3.89.11` that is #115,
#116, #138 and #140, plus a finding of this suite that has no upstream issue yet, `double-join`: under AddressSanitizer
rfd aborts when a receiver is deregistered (`init(url, '')`), because the receiver's dispatcher thread is joined a second
time from the destructor after an explicit stop (libelvutils `Actor::Stop()`); the release build does not notice.
Against `main`, `double-join` only.

## Running it

Everything that needs the daemons runs in docker; the simulator's own unit tests run anywhere with Node ≥ 22.

```sh
npm ci
npm test                       # unit tests of the simulator
npm run lint

scripts/run-tests.sh           # build the image for OpenCCU-Base 3.89.11, run the suite release + asan
scripts/run-tests.sh --ref main --variants release --fuzz 60
```

By hand:

```sh
docker build -f docker/Dockerfile --target test --build-arg BASE_REF=3.89.11 -t hm-radio-simulator .
docker run --rm --init -v "$PWD/results:/results" hm-radio-simulator            # release daemons
docker run --rm --init -e HMRS_VARIANT=asan hm-radio-simulator                  # ASan/UBSan daemons
docker run --rm --init hm-radio-simulator node --test test/daemon/rfd-pty-module.test.js

docker build -f docker/Dockerfile --target fuzz --build-arg BASE_REF=main -t hm-radio-simulator-fuzz .
docker run --rm -e FUZZ_SECONDS=60 -v "$PWD/results/fuzz:/results" hm-radio-simulator-fuzz
```

The image is Debian trixie on purpose: bookworm's sanitizer runtimes (LLVM 14, GCC 12) crash at start-up on kernels
that randomise `mmap` with 32 bits, which looks like a flaky segfault in every fourth ASan run; trixie's LLVM 19 and
GCC 14 do not.

Environment inside the image: `HMRS_VARIANT` (`release`, `asan`), `HMRS_KNOWN_BROKEN` (issue numbers), `HMRS_SEED`
(the frame fuzzer's seed, logged by every run), `HMRS_FUZZ_FRAMES` (default 400). Results: `results/<variant>/junit.xml`,
the daemons' logs and sanitizer reports under `results/<variant>/work/`, fuzz artifacts under `results/fuzz/artifacts/`.

CI (`.github/workflows/ci.yml`) runs the unit tests on Node 22 and 24, the daemon suite for `3.89.11` and `main` in
both variants, and 60 s of each fuzz harness against `main` (findings fail the job) and `3.89.11` (findings are
expected there and only reported). The docker layers are cached per ref.

## The simulated module

`lib/` is a small library:

- `frame.js` - the serial framing (`0xFD`, 16-bit length, payload, CRC-16/0x8005, `0xFC` escapes) with a streaming
  parser that mirrors the daemon's reassembly.
- `commands.js` - the module's command set: system commands (identify, versions, serial, clock, duty cycle, CSMA/CA)
  and BidCoS commands (RF address, send telegram, AES keys, link peers, authentication) with their status codes.
- `module.js` - `RadioModule`, the state machine: answers every command, keeps the address, keys, peers and clock the
  daemon set, reports telegrams through a pluggable _air_ (`TELEGRAM_SENT`, acknowledged, failed), sends events and
  duty-cycle events, switches between application and bootloader, and takes injected faults (`BUSY`, drop, delay).
  Every command it sees is logged for assertions (`module.commands`, `module.waitForCommand()`).
- `pty.js` - the UART attachment: `socat PTY,link=…,raw,echo=0,wait-slave TCP:…` puts the module behind a device node
  the daemon opens as its `ComPortFile`; killing socat is "module lost".
- `binrpc-raw.js` - a raw BIN-RPC encoder that can also produce the malformed messages the robustness tests send.

```js
import {RadioModule, createPtyModule} from 'hm-radio-simulator';

const module = new RadioModule({serial: 'SIM0000001', mode: 'bootloader'});
const pty = await createPtyModule({module, link: '/run/sim/uart0'});
// rfd.conf: [Interface 0] Type = CCU2, ComPortFile = /run/sim/uart0, AccessFile = /dev/null, ResetFile = /dev/null
await module.waitForCommand('SET_RF_ADDRESS');
module.sendEvent({type: 0x40, src: 0xabcdef, dst: module.rfAddress, payload: [0x01, 0x05]});
```

### Timing: what the daemon actually waits for

The radio timing proper - BidCoS frame timing, the device's acknowledgement window, burst wake-ups, CSMA/CA, the duty
cycle - happens inside the **module firmware**. The daemon never sees it; it sees status codes and waits for them with
timeouts of seconds. The simulator therefore models the air logically (a status after a declared delay) and only has
to meet the **host-side** windows, which in OpenCCU-Base 3.89.11 are:

| Daemon | Window                                                       | Value                                                     |
| ------ | ------------------------------------------------------------ | --------------------------------------------------------- |
| rfd    | response to a coprocessor command (identify, versions, keys) | 1000 ms, then up to 2 retries after `BUSY` (250 ms apart) |
| rfd    | status of a sent telegram                                    | 4000 ms (12000 ms for a triple burst)                     |
| rfd    | the module reaching the application after a start command    | 20 × 250 ms                                               |
| rfd    | receive loop                                                 | `select()` with 1 s, 256-byte reads, any chunking         |
| hs485d | answer from the HMW-LGW (also the `K` keepalive)             | 700 ms                                                    |
| HM-LGW | reconnect back-off                                           | 5 s, growing to ~60 s                                     |

A pty has no baud rate (115200 baud would be ~87 µs per byte), so the simulator is a faster module, never a slower one.
Node's event-loop latency is well under a millisecond for a heap this size - two to three orders of magnitude below
every window. Assertions on time use margins, never exact values. The delays the simulator itself uses (`DEFAULTS` in
`module.js`: 30 ms until "sent", 80 ms until an acknowledgement, 3 s until "failed") are **chosen**, not measured; a
calibration against a real module is planned.

One daemon behaviour worth knowing: rfd flushes its serial input before every command it sends, so an unsolicited
event that arrives in that instant is dropped by rfd itself - with a real module too.

## Stages

| Stage | Content                                                                                                                         | State                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 0     | the docker image (release + ASan from an OpenCCU-Base ref), RPC black-box tests, libFuzzer harnesses                            | built, under test     |
| 1a    | the simulated RPI-RF-MOD on a pty: init to `CONNECTED`, bootloader, `BUSY`, module lost and back, events, frame fuzzing         | built, under test     |
| 1b    | the LAN gateway, plaintext: hmlangw in front of the pty module, rfd with `Type = HMLGW2`                                        | ready                 |
| 2     | one simulated switch driven by the `rftypes` XML: pairing, set/ACK, status, UNREACH, CONFIG_PENDING, duty cycle; callback tests | ready                 |
| 3     | a remote, the LAN gateway with the AES handshake and reconnect scenarios, AES devices                                           | ready                 |
| 4     | hs485d against a simulated HMW-LGW with one wired actuator                                                                      | ready                 |
| 5     | multimacd in a VM with `eq3_char_loop` and the dual-coprocessor protocol                                                        | to be refined         |
| -     | calibration of the module timing against a real RPI-RF-MOD                                                                      | later                 |

## Credits and licences

- This repository: MIT, Sebastian Raff.
- [OpenCCU-Base](https://github.com/OpenCCU/OpenCCU-Base) (the OpenCCU project, eQ-3 AG): the daemons under test
  and their device descriptions, fetched at image-build time. HMSL 2 for the daemons and descriptions, LGPL 2.1 for
  libXmlRpc and libxmlparser (`licenses/` in the image). Nothing of it is part of this repository.
- [ReGaHss-Test](https://github.com/OpenCCU/ReGaHss-Test) (Jens Maus, Sebastian Raff; MIT): the model for the
  image and the suite - the same idea for ReGaHss.
- [hmlangw](https://github.com/OpenCCU/OpenCCU/tree/master/buildroot-external/package/hmlangw) (Oliver Kastl,
  Jens Maus, Jérôme Pech; MIT): the HM-LGW emulation stage 1b will build on.
- [FHEM](https://fhem.de)'s `00_HMUARTLGW.pm` (GPL) and [Homegear](https://github.com/Homegear) (GPL): read as
  documentation of the module protocol; no code of theirs is used.
- [binrpc](https://github.com/hobbyquaker/binrpc) and [homematic-xmlrpc](https://github.com/hobbyquaker/homematic-xmlrpc)
  (MIT): the RPC clients the tests use.
- [socat](http://www.dest-unreach.org/socat/) (GPL, in the image): the pty.
