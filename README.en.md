# hm-radio-simulator

[:de: Deutsches README](README.md)

[![CI](https://github.com/hobbyquaker/hm-radio-simulator/actions/workflows/ci.yml/badge.svg)](https://github.com/hobbyquaker/hm-radio-simulator/actions/workflows/ci.yml)
[![Test report](https://img.shields.io/badge/test%20report-GitHub%20Pages-2ea44f)](https://hobbyquaker.github.io/hm-radio-simulator/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A simulated Homematic **radio module** and a **test suite for the CCU's radio daemons** - `rfd` and `hs485d` of
[OpenCCU-Base](https://github.com/OpenCCU/OpenCCU-Base), later `multimacd`.

[hm-simulator](https://github.com/hobbyquaker/hm-simulator) plays the CCU's interface processes towards their
clients. This project points the other way: it plays the **hardware** towards the real daemons - the RPI-RF-MOD /
HM-MOD-RPI-PCB on a serial line, the HM-LGW over TCP, the HMW-LGW over TCP - so that the daemons can be started,
exercised and broken in a container, in CI, without a radio module in the room. The daemons are built from
OpenCCU-Base at a chosen ref inside the docker image; nothing of theirs is copied here.

**Status:** stage 0 (the image, RPC black-box tests, libFuzzer harnesses), stage 1a (the simulated module on a
pty: rfd's init to `CONNECTED`, module lost, frame fuzzing) and stage 1b (the LAN gateway through hmlangw, plaintext)
exist. See _Stages_ for what follows.

## What it tests

| Test file                                | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/daemon/rfd-rpc.test.js`            | rfd's RPC surface: method list over BIN-RPC and XML-RPC on the same port, `listDevices`, `listBidcosInterfaces`, `init` registers a receiver and rfd calls `listDevices`/`newDevices` on it; and the measurement that rfd 3.89.11 does not start without a configured interface ("No BidCoS-Interface available"), which is why these tests run with the simulated module too                                                                                                                                                                                               |
| `test/daemon/rfd-rpc-robustness.test.js` | OpenCCU-Base [#138](https://github.com/OpenCCU/OpenCCU-Base/pull/138) nested `system.multicall`, [#140](https://github.com/OpenCCU/OpenCCU-Base/pull/140) malformed BIN-RPC, hostile XML-RPC, [#27](https://github.com/OpenCCU/OpenCCU-Base/pull/27) a receiver that disappears                                                                                                                                                                                                                                                                                             |
| `test/daemon/hs485d-rpc.test.js`         | hs485d against a silent TCP bus: method list, `listDevices`, #138 and #140 on hs485d                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/daemon/rfd-pty-module.test.js`     | the simulated module on a pty: rfd's init sequence and `CONNECTED`; the module in the bootloader; a `BUSY` retry; module lost ([#115](https://github.com/OpenCCU/OpenCCU-Base/pull/115), [#116](https://github.com/OpenCCU/OpenCCU-Base/pull/116)); module back; events; frame fuzzing                                                                                                                                                                                                                                                                                      |
| `test/daemon/rfd-lgw-hmlangw.test.js`    | rfd with `Type = HMLGW2` against hmlangw in front of the simulated module (openccu-lite's HM-LGW mode): init to `CONNECTED`, the keepalive on 2001, a serial in the other case ([#17](https://github.com/OpenCCU/OpenCCU-Base/pull/17)), a wrong serial, no gateway at start, gateway lost and back (`CONNECTED = false`, reconnect, re-init of the module), the retry interval, hmlangw without `-b` (the module parked in the bootloader)                                                                                                                                 |
| `test/daemon/rfd-switch.test.js`         | one simulated switch (HM-LC-Sw1-Pl from the image's `rf_s.xml`) on the air behind the module: pairing in install mode (the announcement, list 0 with the central's address, the AES key exchange, the lists and peers read back, `newDevices`), a set with `ACK_STATUS` and its event, a status report, UNREACH/STICKY_UNREACH with the service message and the device's return, CONFIG_PENDING for a configuration delivered after the return, the duty cycle, events on a BIN-RPC and an XML-RPC receiver; every test leaves the air's telegrams as a trace in the report |
| `fuzz/`                                  | libFuzzer harnesses for `XmlRpcValue` (BIN-RPC and XML deserializers), the request dispatcher with `system.multicall`, and `xmlParser`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/`                             | the simulator itself: framing and CRC, the module state machine, the raw BIN-RPC encoder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

A regression test for a bug the chosen OpenCCU-Base ref does not have the fix for runs as `todo` (`HMRS_KNOWN_BROKEN`,
set per ref by the Dockerfile), so the run shows what happens without going red. Against `3.89.11` that is #115,
#116, #138 and #140, plus a finding of this suite that has no upstream issue yet, `double-join`: under AddressSanitizer
rfd aborts when a receiver is deregistered (`init(url, '')`), because the receiver's dispatcher thread is joined a second
time from the destructor after an explicit stop (libelvutils `Actor::Stop()`); the release build does not notice.
The second finding without an issue yet is `read-eof`: a pty slave whose master went away
answers `read()` with 0 (end of file), which #115/#116 do not treat as an error (they handle -1: `ENODEV` from a stale
`/dev/mmd_bidcos`, `EIO` from an unplugged adapter), so rfd on `main` still spins at 100 % CPU and keeps
`CONNECTED = true` after the hangup. Against `main`, `double-join` and `read-eof`. Every finding has an issue draft in
[`upstream-reports/`](upstream-reports/) (German README, English drafts); nothing is reported upstream until the
maintainer decides.

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
docker run --rm --init --cap-add SYS_NICE -v "$PWD/results:/results" hm-radio-simulator   # release daemons
docker run --rm --init --cap-add SYS_NICE -e HMRS_VARIANT=asan hm-radio-simulator         # ASan/UBSan daemons
docker run --rm --init --cap-add SYS_NICE hm-radio-simulator node --test test/daemon/rfd-pty-module.test.js

docker build -f docker/Dockerfile --target fuzz --build-arg BASE_REF=main -t hm-radio-simulator-fuzz .
docker run --rm -e FUZZ_SECONDS=60 -v "$PWD/results/fuzz:/results" hm-radio-simulator-fuzz
```

`--cap-add SYS_NICE` is for hmlangw, which starts its threads with `SCHED_RR`; without the capability it exits silently
with code 1 and the LAN-gateway tests fail at start.

The image is Debian trixie on purpose: bookworm's sanitizer runtimes (LLVM 14, GCC 12) crash at start-up on kernels
that randomise `mmap` with 32 bits, which looks like a flaky segfault in every fourth ASan run; trixie's LLVM 19 and
GCC 14 do not.

Environment inside the image: `HMRS_VARIANT` (`release`, `asan`), `HMRS_KNOWN_BROKEN` (issue numbers), `HMRS_SEED`
(the frame fuzzer's seed, logged by every run), `HMRS_FUZZ_FRAMES` (default 400). Results: `results/<variant>/junit.xml`,
the daemons' logs and sanitizer reports under `results/<variant>/work/`, fuzz artifacts under `results/fuzz/artifacts/`.

CI (`.github/workflows/ci.yml`) runs the unit tests on Node 22 and 24, the daemon suite for `3.89.11` and `main` in
both variants, and 60 s of each fuzz harness against `main` (findings fail the job) and `3.89.11` (findings are
expected there and only reported). The docker layers are cached per ref.

## The test report

Every CI run writes a Markdown overview into its summary on GitHub (per job, and for the whole run in the "test report"
job). A run on `main` also publishes an HTML report on GitHub Pages: **<https://hobbyquaker.github.io/hm-radio-simulator/>**

- the OpenCCU-Base refs side by side (`3.89.11` and `main`, release and ASan each), every test's outcome, duration and
  diagnostics, the fuzz runs, and the history of the last 20 runs (`runs/<id>/`). How to read it:

- **regression** - the test pins a fixed OpenCCU-Base bug and links to the pull request and its merge commit; on a ref
  that predates the fix it runs as **todo** (known broken, the run stays green);
- **known bug** - a finding of this suite without an upstream fix (`double-join`, `read-eof`), linking to the issue or,
  until there is one, to the findings above;
- **behaviour** - a measured daemon behaviour; **fuzz** - the suite's seeded fuzzing tests.

The data is next to the page as `report.json`. Nothing of it is committed: the report is built from the run's
artifacts by `scripts/report.mjs` (a node:test JSON reporter writes `tests.json`, the entrypoint `meta.json` with the
OpenCCU-Base commit, `fuzz/run.sh` a `fuzz-summary.json`; `test/metadata.js` holds the upstream links), locally with
`npm run report` after `scripts/run-tests.sh`.

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
- `hmlangw.js` - the LAN-gateway attachment: hmlangw (MIT, fetched from the OpenCCU repository at a pinned commit and
  built into the image) in front of the pty module, listening on the HM-LGW ports 2000 and 2001; killing it is
  "gateway lost". Two quirks of hmlangw 1.1.1 surfaced: its threads want `SCHED_RR` (hence `SYS_NICE`), and its
  debug output (`-D`) crashes in `sendEnterBootloader()` on swapped `fprintf` arguments, so `-D` is only used with
  `-b` (the production setting, which skips that function).
- `telegram.js` - BidCoS telegrams as the module carries them (counter, control byte, type, source, destination,
  payload - no length byte), with the frame types, control bits and subtypes of rfd's own `BidcosFrame.h`.
- `rftypes.js` - a reader for the `rftypes/*.xml` device descriptions rfd uses (a small XML parser, no dependency):
  the supported types with their sysinfo conditions, the channels and their config parameters (list, index, size),
  and the `<frame>` definitions, matched and built with the XML's `index`/`size` bit-field notation.
- `device.js` - `BidcosDevice`, a simulated device: the generic protocol (the pairing announcement, CONFIG_START /
  WRITE_INDEX / END into its lists, CONFIG_PARAM_REQ answered with INFO_PARAM pairs, the peer list, status requests,
  acknowledgements, the AES key container accepted) plus a thin behaviour per type - `SwitchBehaviour` for the
  HM-LC-Sw1 family (LEVEL_SET → ACK_STATUS, LEVEL_GET → INFO_LEVEL).
- `air.js` - the virtual air between the module and the devices: the module's `air` hook. A device's first answer
  becomes the module's `TELEGRAM_SENT_RECVD_ACK`, further answers follow as events, a silent device ends in
  `SEND_FAILED`, a forced status (`SEND_FAILED_DUTYCYCLE`) replaces the send; every telegram is traced by its frame
  name for the report.
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

| Daemon | Window                                                       | Value                                                                                                  |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| rfd    | response to a coprocessor command (identify, versions, keys) | 1000 ms, then up to 2 retries after `BUSY` (250 ms apart)                                              |
| rfd    | status of a sent telegram                                    | 4000 ms (12000 ms for a triple burst)                                                                  |
| rfd    | the module reaching the application after a start command    | 20 × 250 ms                                                                                            |
| rfd    | receive loop                                                 | `select()` with 1 s, 256-byte reads, any chunking                                                      |
| hs485d | answer from the HMW-LGW (also the `K` keepalive)             | 700 ms                                                                                                 |
| HM-LGW | preamble (`H`, `S`, the `>` answer) and the `K` keepalive    | 2 s for the preamble; a `K` every ~1 s, `>K` within 4 s                                                |
| HM-LGW | reconnect retry                                              | every 5 s with a configured IP (measured: constant); the growth to ~60 s only for the search by serial |

A pty has no baud rate (115200 baud would be ~87 µs per byte), so the simulator is a faster module, never a slower one.
Node's event-loop latency is well under a millisecond for a heap this size - two to three orders of magnitude below
every window. Assertions on time use margins, never exact values. The delays the simulator itself uses (`DEFAULTS` in
`module.js`: 30 ms until "sent", 80 ms until an acknowledgement, 3 s until "failed") are **chosen**, not measured; a
calibration against a real module is planned.

One daemon behaviour worth knowing: rfd flushes its serial input before every command it sends, so an unsolicited
event that arrives in that instant is dropped by rfd itself - with a real module too. Over the LAN gateway, measured on
3.89.11: with a configured `IP Address` rfd does not query the module's serial (`GET_SERIALNR` is absent from the init),
and `CONNECTED` turns true with the text preamble - the coprocessor re-initialisation after a reconnect follows it.

The module's `STARTBOOTLOADER` handling is a chosen default too: it answers OK, restarts, and announces the new mode
with an identify frame carrying counter 0 - the exact frame hmlangw waits for after its enter-bootloader command
(`FD 00 0C 00 00 00 "Co_CPU_BL" 72 51`, which also pins the CRC against a real module's bytes); a command arriving
during the restart is lost. The answer is needed: rfd's `improvedInit()` has a fallback for a module that does not
answer (the identify event after 2.5 s), but measured on 3.89.11 it cannot fire - the event handler only try-locks the
coprocessor-state mutex that `improvedInit()` holds while it waits, so rfd gives the interface up after three tries.
`startBootloaderAcknowledged: false` reproduces that.

## Stages

| Stage | Content                                                                                                                         | State         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 0     | the docker image (release + ASan from an OpenCCU-Base ref), RPC black-box tests, libFuzzer harnesses                            | done          |
| 1a    | the simulated RPI-RF-MOD on a pty: init to `CONNECTED`, bootloader, `BUSY`, module lost and back, events, frame fuzzing         | done          |
| 1b    | the LAN gateway, plaintext: hmlangw in front of the pty module, rfd with `Type = HMLGW2`                                        | done          |
| -     | the test report: a Markdown summary per CI run and an HTML report on GitHub Pages with history and upstream links               | done          |
| 2     | one simulated switch driven by the `rftypes` XML: pairing, set/ACK, status, UNREACH, CONFIG_PENDING, duty cycle; callback tests | testing       |
| 3     | a remote, the LAN gateway with the AES handshake and reconnect scenarios, AES devices                                           | enqueued      |
| 4     | hs485d against a simulated HMW-LGW with one wired actuator                                                                      | enqueued      |
| 5     | multimacd in a VM with `eq3_char_loop` and the dual-coprocessor protocol                                                        | to be refined |
| -     | calibration of the module timing against a real RPI-RF-MOD                                                                      | enqueued      |
| -     | the test report: the four result columns right-aligned and the same width in every table                                        | in progress   |
| -     | the test report: code coverage of rfd and hs485d from the suite                                                                 | enqueued      |
| -     | upstream reports: `upstream-reports/` with one issue draft per daemon finding, nothing reported yet                             | done          |
| -     | run the suite whenever OpenCCU-Base main moves: a 15-minute poll, the suite for that exact commit, noted on the report          | enqueued      |
| -     | more daemon tests (the collection, split into the items below)                                                                  | not as such   |
| -     | an RPC method sweep, a device-type sweep over all rftypes descriptions, the 3.89.11/main differential                           | ready         |
| -     | the receiver contract: several receivers, init sync, event order, the unreachable rule, a stalled receiver                      | ready         |
| -     | restart, device files and config: persistence, broken files, address donation, the start-up matrix                              | ready         |
| -     | firmware update flows with a simulated device (rfd) and the Hexfile path (hs485d)                                               | ready         |
| -     | more fuzz targets: frames from a paired device, the frame, LGW, XML and device-file parsers                                     | ready         |
| -     | a ThreadSanitizer image variant                                                                                                 | ready         |

## Credits and licences

- This repository: MIT, Sebastian Raff.
- [OpenCCU-Base](https://github.com/OpenCCU/OpenCCU-Base) (the OpenCCU project, eQ-3 AG): the daemons under test
  and their device descriptions, fetched at image-build time. HMSL 2 for the daemons and descriptions, LGPL 2.1 for
  libXmlRpc and libxmlparser (`licenses/` in the image). Nothing of it is part of this repository.
- [ReGaHss-Test](https://github.com/OpenCCU/ReGaHss-Test) (Jens Maus, Sebastian Raff; MIT): the model for the
  image and the suite - the same idea for ReGaHss.
- [hmlangw](https://github.com/OpenCCU/OpenCCU/tree/master/buildroot-external/package/hmlangw) (Oliver Kastl,
  Jens Maus, Jérôme Pech; MIT): the suite's LAN gateway, fetched and built at image-build time.
- [FHEM](https://fhem.de)'s `00_HMUARTLGW.pm` (GPL) and [Homegear](https://github.com/Homegear) (GPL): read as
  documentation of the module protocol; no code of theirs is used.
- [binrpc](https://github.com/hobbyquaker/binrpc) and [homematic-xmlrpc](https://github.com/hobbyquaker/homematic-xmlrpc)
  (MIT): the RPC clients the tests use.
- [socat](http://www.dest-unreach.org/socat/) (GPL, in the image): the pty.
