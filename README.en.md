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

**Status:** stages 0 to 4 exist (the module, the LAN gateway with and without AES, a simulated switch and a remote
for rfd; a wired LAN gateway with a wired actuator for hs485d). See _Stages_ for what follows.

## What it tests

| Test file                                   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/daemon/rfd-rpc.test.js`               | rfd's RPC surface: method list over BIN-RPC and XML-RPC on the same port, `listDevices`, `listBidcosInterfaces`, `init` registers a receiver and rfd calls `listDevices`/`newDevices` on it; and the measurement that rfd 3.89.11 does not start without a configured interface ("No BidCoS-Interface available"), which is why these tests run with the simulated module too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/daemon/rfd-rpc-robustness.test.js`    | OpenCCU-Base [#138](https://github.com/OpenCCU/OpenCCU-Base/pull/138) nested `system.multicall`, [#140](https://github.com/OpenCCU/OpenCCU-Base/pull/140) malformed BIN-RPC, hostile XML-RPC, [#27](https://github.com/OpenCCU/OpenCCU-Base/pull/27) a receiver that disappears                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `test/daemon/hs485d-rpc.test.js`            | hs485d against a silent TCP bus: method list, `listDevices`, #138 and #140 on hs485d                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `test/daemon/rfd-pty-module.test.js`        | the simulated module on a pty: rfd's init sequence and `CONNECTED`; the module in the bootloader; a `BUSY` retry; module lost (the hangup gives `read()` = 0; #115/#116 handle `read()` = -1 and are not covered yet); module back; events; frame fuzzing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `test/daemon/rfd-lgw-hmlangw.test.js`       | rfd with `Type = HMLGW2` against hmlangw in front of the simulated module (openccu-lite's HM-LGW mode): init to `CONNECTED`, the keepalive on 2001, a serial in the other case ([#17](https://github.com/OpenCCU/OpenCCU-Base/pull/17)), a wrong serial, no gateway at start, gateway lost and back (`CONNECTED = false`, reconnect, re-init of the module), the retry interval, hmlangw without `-b` (the module parked in the bootloader)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/daemon/rfd-switch.test.js`            | one simulated switch (HM-LC-Sw1-Pl from the image's `rf_s.xml`) on the air behind the module: pairing in install mode (the announcement, list 0 with the central's address, the AES key exchange, the lists and peers read back, `newDevices`), a set with `ACK_STATUS` and its event, a status report, UNREACH/STICKY_UNREACH with the service message and the device's return, CONFIG_PENDING for a configuration delivered after the return, the duty cycle, events on a BIN-RPC and an XML-RPC receiver; every test leaves the air's telegrams as a trace in the report                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/daemon/rfd-lgw-front.test.js`         | rfd against the JavaScript HM-LGW front (`lib/lgw.js`) with `Encryption Key`: the `V` handshake and AES-128-CFB on both ports, the init through the encrypted channel, a wrong LAN key (rfd reports `WRONG_KEY` and exits), plaintext, port 2000 dropped, port 2001 dropped, a silent keepalive, the gateway gone and back with a wrong serial in the first hello ([#13](https://github.com/OpenCCU/OpenCCU-Base/pull/13), [#16](https://github.com/OpenCCU/OpenCCU-Base/pull/16), [#17](https://github.com/OpenCCU/OpenCCU-Base/pull/17)), port 2000 dropped while a telegram is in flight, and the module power-cycled behind the gateway: rfd republishes the devices and keys (`restoreConfigToCoprocessor`) but not the per-channel AES policy (`aes-republish`)                                                                                                                                                                                                              |
| `test/daemon/rfd-aes-remote.test.js`        | AES devices and a remote (HM-RC-4 from `rf_rc.xml`): the key exchange at pairing, `AES_ACTIVE` puts the channel under authentication in the module (`AUTHENTICATION_ON`), a set runs the challenge-response (the air does what the module firmware does on real hardware: `ACK_W_AES_CHALLENGE`, `AES_SOLUTION`, the signed ACK), a device on another key fails (`UNREACH`); the remote's `PRESS_SHORT`/`PRESS_LONG`, whose keys rfd authenticates by default (`aes_default`), the configuration of a sleeping device (`CONFIG_PENDING`, delivered when its config button is pressed), a direct link between remote and switch (`addLink`, the peer lists on both sides, `getLinks`, the LINK paramset as list 3 in the switch, `removeLink`)                                                                                                                                                                                                                                      |
| `test/daemon/rfd-wakeup.test.js`            | devices that sleep (HM-PB-2-WM55 `CONFIG,WAKEUP`, HM-RC-4-2 with `LAZY_CONFIG`, HM-Sec-MDIR, HM-LC-Sw1-Ba-PCB `BURST`): a MASTER write to a sleeping wake-up device is tried once, then stays pending while rfd asks the module for the wake-up (`ADD_LINK_PEER` with the wake-up byte, and the lazy-config byte), the device's next telegram comes with the module's `WOKEN_UP` flag and rfd delivers the configuration and clears the request; commands to a sleeping device wait in rfd's queue of ten (of twelve, the two oldest are dropped with a warning); `deleteDevice` with `DEFER` waits for the wake-up, `abortDeleteDevice` cancels it; a burst device gets its first telegram as a burst, the next within 1.8 s without, a missed try is repeated as a burst, a silent one ends in `UNREACH`                                                                                                                                                                         |
| `test/daemon/rfd-two-interfaces.test.js`    | rfd with two interfaces on one air - an RPI-RF-MOD on a pty and an HM-LGW with a LAN key on a second loopback address, each hearing a device with its own RSSI: both listed, `setInterfaceClock` reaches both modules; a new device is paired through the interface that hears it better (even when that is not the default); `rssiInfo` with both values; `setBidcosInterface` moves a device (`ADD_LINK_PEER` on the new module, `REMOVE_LINK_PEER` on the old); roaming - a better copy arriving second moves the device after 150 ms, not within 300 ms of a send, a better copy arriving first only with the next send; one interface lost, the devices on the other carry on and a roaming device is taken over; the duty-cycle bands (an event per band change, none inside a band, per interface, downwards with hysteresis); the finding `unknown-interface`                                                                                                              |
| `test/daemon/hs485d-lgw.test.js`            | hs485d (`-g`) against the HMW-LGW in JavaScript (`lib/hmwlgw.js`) with a simulated HMW-LC-Sw2-DR on the bus (`lib/wired.js`, from the image's `hs485types`): the connection with the same preamble as the HM-LGW (also encrypted with `-k`), the `K` keepalive every 20 s, discovery (`D` → `d`/`c`, then `h`/`v`/`n` and the EEPROM usage `E`), a set with `x` and the `i` event, a read with `S`, key presses as `PRESS_SHORT`/`PRESS_LONG` (a repeated counter without SYN is dropped), a new device's announcement (`A`), paramsets in the EEPROM (`W`/`R`), a link key → actuator, a silent device (`a 01`, `UNREACH`/`STICKY_UNREACH`), the keepalive timeout with the reconnect, and a restart with the device files, among them a type byte ≥ 0x80 ([#9](https://github.com/OpenCCU/OpenCCU-Base/pull/9))                                                                                                                                                                  |
| `test/daemon/udp-search.test.js`            | the UDP device search of libLanDeviceUtils (`lib/eq3udp.js` answers on 43439): rfd finds an HM-LGW configured by serial only, hs485d its HMW-LGW (`-s`) - and hs485d searches the gateway by serial on every reconnect, even when started with `-h`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `test/daemon/rfd-sweep.test.js`             | the sweeps over rfd: `system.listMethods` equals the dispatcher table read from the source at image-build time (`scripts/method-table.mjs`, 52 methods at 3.89.11); every method with valid, missing, extra and wrong-typed arguments (nine values per position); one device of every `rftypes` type without radio (`addVirtualDeviceInstance`, the announcement built from the type's conditions: 341 of 343, the two central types have none) with the descriptions, paramsets and values of every address. rfd must survive all of it without a sanitizer report; every answer is recorded for the differential                                                                                                                                                                                                                                                                                                                                                                 |
| `test/daemon/hs485d-sweep.test.js`          | the same for hs485d (25 methods) against the JavaScript HMW-LGW, and one wired device of every `hs485types` type with a condition (15) on the simulated bus, found by `searchDevices`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `test/daemon/receiver-contract.test.js`     | the receiver contract of rfd and hs485d (libhsscomm): three receivers synced with their own ids, `ping` sends PONG to all, 20 events arrive in order at each; the init sync (the receiver's `listDevices` decides: unknown addresses deleted, another VERSION re-sent, the same left out); the unreachable rule as measured - ten failed deliveries in a row and the eleventh event removes the receiver and its handlers-file entry, a success resets the count; a hanging receiver delays only itself; service messages re-sent to a late receiver; `replaceDevice` reaches every registered receiver                                                                                                                                                                                                                                                                                                                                                                            |
| `test/daemon/restart-config.test.js`        | restart, device files and config: one device of every `rftypes` type, rfd stopped cleanly through its `exit` method and started again - every address, type, version and channel is back (plus the smoke detectors' team devices, which only loading from a file creates); the same for every `hs485types` type. A truncated device file is dropped, garbage and empty files skipped, leftover `.bak`/`.new` copies ignored, a missing channel re-created. Address donation (`BidCoS-Address = 0`, a fresh system's first start: the module's default address, persisted); `changeKey` persists key and index, a restart loads them; receivers survive a restart (`XmlRpcHandlersFile`). The start-up matrix: missing config file, unknown interface `Type`, `Log Destination` File and None, `UDS File`, a taken port ("Could not bind", exit code 0), two interfaces, the legacy coprocessor init, sniffing mode (`-s`), hs485d's extra description dir `/etc/config/hs485types` |
| `test/daemon/receiver-misbehaviour.test.js` | a misbehaving receiver (rfd and hs485d, BIN-RPC and XML-RPC callbacks; a byte-level receiver in `test/helpers/raw-receiver.js`): it closes mid-request, vanishes, never answers or stops reading, answers with an HTTP error, a fault, garbage, truncated, the wrong type, several MB, byte by byte or twice - the other receiver still gets its events in ~10 ms, RPC answers, the radio side switches, the daemon's threads and fds are back where they were. Plus huge and invalid `listDevices` answers at init, 100 re-registrations, two receivers with one id, a URL nobody answers on. Two findings: `init-blocks` and `async-callback-threads`                                                                                                                                                                                                                                                                                                                            |
| `test/daemon/listmethods-truth.test.js`     | `listMethods` tells the truth (rfd and hs485d, BIN-RPC and XML-RPC): every listed name is known to the dispatcher (asked through `system.methodHelp`, the harmless ones also called) and no other name is - every name in the daemons' sources (registered or not), the other daemon's, names of other Homematic interfaces, case and whitespace variants; destructive methods are never called. On `3.89.11`: rfd lists 55, all callable; hs485d 28 of 28; no unlisted name is callable (hs485d's unregistered `activateLinkParamset` included); `system.methodHelp` does not know `system.multicall` (built into the connection), there is no `system.methodSignature`. A table on the report                                                                                                                                                                                                                                                                                    |
| `test/daemon/rfd-load.test.js`              | load on rfd (six switches and a remote on the air with computed airtime): a burst at 50 % of the air maximum (8.3 of 16.7 commands per second) with a `putParamset` in it and remote presses meanwhile - every call answered, every command on the air once and in order, every press delivered, the last value wins; 21 values to one channel over BIN-RPC and XML-RPC, nothing collapsed; a sustained run at 50 % of the duty-cycle budget (window scaled to 30 s) - rfd reports what the module counts, memory flat; an overload at 200 % with the duty cycle exceeded - RPC answers, events arrive, rfd recovers. The numbers on the report                                                                                                                                                                                                                                                                                                                                    |
| `fuzz/`                                     | libFuzzer harnesses for `XmlRpcValue` (BIN-RPC and XML deserializers), the request dispatcher with `system.multicall`, and `xmlParser`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `test/unit/`                                | the simulator itself: framing and CRC, the module state machine, the raw BIN-RPC encoder, the LGW front's cipher streams, the AES handshake, the device model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

A regression test for a bug the chosen OpenCCU-Base ref does not have the fix for runs as `todo` (`HMRS_KNOWN_BROKEN`,
set per ref by the Dockerfile), so the run shows what happens without going red. Against `3.89.11` that is
#138 and #140, plus eleven findings of this suite that have no upstream issue yet. `double-join`: under AddressSanitizer
rfd aborts when a receiver is deregistered (`init(url, '')`), because the receiver's dispatcher thread is joined a second
time from the destructor after an explicit stop (libelvutils `Actor::Stop()`); the release build does not notice.
The second finding without an issue yet is `read-eof`: a pty slave whose master went away
answers `read()` with 0 (end of file), which #115/#116 do not treat as an error (they handle -1: `ENODEV` from a stale
`/dev/mmd_bidcos`, `EIO` from an unplugged adapter), so rfd on `main` still spins at 100 % CPU and keeps
`CONNECTED = true` after the hangup. The third, `aes-republish`: when the coprocessor is re-initialised behind a
reconnected LAN gateway, rfd re-adds every device (`ADD_LINK_PEER`) and the keys, but not the per-channel AES policy
(`AUTHENTICATION_ON`); until rfd restarts or the channel's configuration is written again, the module no longer
authenticates the events of AES channels and rfd rejects them (`auth_violate_policy="reject"`) - a remote with AES
goes silent. The fourth, `wired-maintenance`: hs485d builds the channels of a newly discovered wired device without
their class, so its maintenance channel does not exist until hs485d restarts and loads the device from its file -
`UNREACH`, `STICKY_UNREACH` and `CONFIG_PENDING` read as "unknown internal value" and no service event fires. The
sweeps found two more under AddressSanitizer: `metadata-args` - `setVolatileMetadata` (and `getMetadata`/`setMetadata`)
takes a pointer into its first argument and then indexes the second; when that is missing, the argument array is
reallocated under the pointer (heap-use-after-free). And `string-uint-conversion` - libhsscomm's
`type_conversion_string_unsigned_integer` walks the `c_str()` of a destroyed temporary string (stack-use-after-scope)
whenever the channels of an HM-OU-LED16 are set up. And `replace-callback`: a receiver that registers after a device was
replaced and still knows the old one gets it as deleted instead of `replaceDevice` - rfd's `IsDeviceReplaced()` always
answers `false`, hs485d's history holds the new serial instead of the old. The misbehaving-receiver test found two more: `init-blocks` - `init` calls the receiver back (`system.listMethods`,
`listDevices`) without a timeout on the daemon's main loop; if it never answers, the whole daemon (RPC, events to
others, timers, the radio side) stands still until the connection closes. And `async-callback-threads` - every
unanswered `newDevices`/`deleteDevices`/`replaceDevice` leaves a thread and a socket behind for good. Against `main`,
`double-join`, `read-eof`, `aes-republish`, `wired-maintenance`, `metadata-args`, `string-uint-conversion`,
`replace-callback`, `init-blocks`, `async-callback-threads` `dutycycle-upper-bound` (when the module reports a 100 % duty cycle, rfd reads past its threshold map; found by the load test) `flush-drops-events` (rfd discards unread input from the module before every command; under load, events get lost) and `unknown-interface` (`setBidcosInterface` with an interface that does not exist reports success and stores it; the device then sits on the default interface). Every finding has an issue draft in
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
the release, ASan and coverage variants, and 60 s of each fuzz harness against `main` (findings fail the job) and `3.89.11` (findings are
expected there and only reported). The docker layers are cached per ref.

## The test report

Every CI run writes a Markdown overview into its summary on GitHub (per job, and for the whole run in the "test report"
job). A run on `main` also publishes an HTML report on GitHub Pages: **<https://hobbyquaker.github.io/hm-radio-simulator/>**

- the OpenCCU-Base refs side by side (`3.89.11` and `main`, release and ASan each), every test's outcome, duration and
  diagnostics, the fuzz runs, and the history of the last 20 runs (`runs/<id>/`). How to read it:

- **regression** - the test pins a fixed OpenCCU-Base bug and links to the pull request and its merge commit; on a ref
  that predates the fix it runs as **todo** (known broken, the run stays green);
- **known bug** - a finding of this suite without an upstream fix (`double-join`, `read-eof`, `aes-republish`, `wired-maintenance`, `metadata-args`, `string-uint-conversion`, `replace-callback`, `init-blocks`, `async-callback-threads`, `dutycycle-upper-bound`, `flush-drops-events`, `unknown-interface`), linking to the issue or,
  until there is one, to the findings above;
- **behaviour** - a measured daemon behaviour; **fuzz** - the suite's seeded fuzzing tests.

**Code coverage** of rfd and hs485d comes from a third build variant, `coverage` (clang source-based coverage, `-O0`),
running the same suite: the report shows, per OpenCCU-Base ref, lines, functions and branches for the daemons' own
sources and for each library as its own row, the per-file percentages, and links the data for download (an lcov
tracefile and llvm-cov's JSON - file paths and counts, no source text; with an OpenCCU-Base checkout at that commit,
`genhtml --prefix /openccu-base coverage.info` renders the annotated view). The daemons have no SIGTERM handler and
would lose their profile when the suite stops them, so the variant uses clang's continuous mode, where the counters
live in an mmapped file. clang was chosen because rfd and hs485d build and pass the suite with it unchanged; the
release and ASan variants stay on gcc.

**The differential:** the release jobs keep the answers of the sweeps (`results/<variant>/sweep/*.json`, short
summaries: a struct's keys, an array's length and first element, a fault's code and text). The report compares
`3.89.11` with `main`, and `main` with the commit the previous published report tested (its records are on the site as
`sweep/main.json`), and lists what changed. A change is not a failure; `getVersion` is ignored by design.

The data is next to the page as `report.json`. Nothing of it is committed: the report is built from the run's
artifacts by `scripts/report.mjs` (a node:test JSON reporter writes `tests.json`, the entrypoint `meta.json` with the
OpenCCU-Base commit, `fuzz/run.sh` a `fuzz-summary.json`; `test/metadata.js` holds the upstream links), locally with
`npm run report` after `scripts/run-tests.sh`.

## When OpenCCU-Base moves

A push in someone else's repository cannot trigger our workflow, so `upstream-watch.yml` polls the head of
OpenCCU-Base `main` every 15 minutes, keeps the last tested commit on the branch `upstream-state` (written only by
this workflow), and when the head is new runs the suite for that exact commit - through the CI workflow as a reusable
workflow, with `3.89.11` next to it as always. The run shows up on the report and in its history as "triggered by
OpenCCU-Base `<sha>`" with the commit linked. Several upstream commits within one interval are tested as their newest
head; the commit on the state branch also counts as repository activity, so GitHub does not disable the schedule. A red
run leaves a warning on the run; it does not open an issue unless the maintainer wants that. `workflow_dispatch` with
`force` re-tests the current head.

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
- `pty.js` - the UART attachment: `socat PTY,link=…,raw,echo=0,wait-slave,pty-interval=0.02 TCP:…` puts the module behind a device node
  the daemon opens as its `ComPortFile`; killing socat is "module lost".
- `hmlangw.js` - the LAN-gateway attachment: hmlangw (MIT, fetched from the OpenCCU repository at a pinned commit and
  built into the image) in front of the pty module, listening on the HM-LGW ports 2000 and 2001; killing it is
  "gateway lost". Two quirks of hmlangw 1.1.1 surfaced: its threads want `SCHED_RR` (hence `SYS_NICE`), and its
  debug output (`-D`) crashes in `sendEnterBootloader()` on swapped `fprintf` arguments, so `-D` is only used with
  `-b` (the production setting, which skips that function).
- `lgw.js` - `LgwFront`, the HM-LGW in JavaScript: the `H`/`V`/`S`/`>` preamble, `Encryption Key` with the `V`
  handshake (the key is the MD5 of the LAN key, one IV per direction, the same on 2001), AES-128-CFB on both ports,
  the keepalive `L`/`K` → `>L`/`>K` with its counter, and the knobs the reconnect tests turn: `drop(kind)`, `lose()`,
  `reappear()`, `answerKeepalive`, `serialOverrideOnce`. Both ports keep a trace of the lines that crossed them.
- `aes.js` - the BidCoS challenge-response as public documentation describes it (Homegear's `AesHandshake.cpp`
  read as documentation; nothing copied): the challenge frame, the session key, the response, the signature check.
- `telegram.js` - BidCoS telegrams as the module carries them (counter, control byte, type, source, destination,
  payload - no length byte), with the frame types, control bits and subtypes of rfd's own `BidcosFrame.h`.
- `rftypes.js` - a reader for the `rftypes/*.xml` device descriptions rfd uses (a small XML parser, no dependency):
  the supported types with their sysinfo conditions, the channels and their config parameters (list, index, size),
  and the `<frame>` definitions, matched and built with the XML's `index`/`size` bit-field notation.
- `device.js` - `BidcosDevice`, a simulated device: the generic protocol (the pairing announcement, CONFIG_START /
  WRITE_INDEX / END into its lists, CONFIG_PARAM_REQ answered with INFO_PARAM pairs, the peer list, status requests,
  acknowledgements, the AES key container accepted, the key index taken from the central's current one) plus a thin
  behaviour per type - `SwitchBehaviour` for the HM-LC-Sw1 family (LEVEL_SET → ACK_STATUS, LEVEL_GET → INFO_LEVEL),
  `RemoteBehaviour` for the HM-RC family (key events with the press counter). An AES device (`aes: true`) answers a
  command with the challenge and checks the response before it acts. `rxMode` says when a device listens: `always`
  (the default), `config`/`wakeup` (a battery device that listens only for 300 ms after its own telegrams, 1 s after a
  wake-up or a telegram it heard, 15 s after its config button) or `burst` (a burst telegram wakes it, then it listens
  for 2 s; rfd assumes 1.8 s) - all chosen, not measured.
- `air.js` - the virtual air between the module and the devices: the module's `air` hook. A device's first answer
  becomes the module's `TELEGRAM_SENT_RECVD_ACK`, further answers follow as events, a silent device ends in
  `SEND_FAILED`, a forced status (`SEND_FAILED_DUTYCYCLE`) replaces the send; every telegram is traced by its frame
  name for the report. The air also does what the module firmware does for AES: it answers a device's challenge with
  the response from the module's key table, and challenges a device itself when its channel is under authentication
  (`AUTHENTICATION_ON`), reporting the event as `AUTH_SUCCESSFUL` or `AUTH_FAILED`. The module answers
  `ADD_LINK_PEER` as the firmware does, with the peer count and the device's authentication mask, which is what rfd
  compares its policy against (a device without AES gets no `AUTHENTICATION_ON/OFF` at all). Its wake-up and
  lazy-config bytes are the wake-up request (`module.wakeupRequest()`): the device's next telegram is answered with a
  WAKEUP telegram (type 0x12, as FHEM's CUL_HM sends it, read as documentation) and reported with `WOKEN_UP`, until rfd
  clears the request with another `ADD_LINK_PEER` (chosen; the firmware's own bookkeeping is not public). A burst
  telegram costs the computed 360 ms preamble on top of the acknowledgement. One air can serve several modules (`modules`, rfd with two interfaces): each
  module hears a device at its own RSSI or not at all (`setRssi`), a device's telegrams and its answers reach every
  module in range (`receiveOrder` and `moduleGapMs` decide which copy rfd sees first).
- `hmwlgw.js` - the HMW-LGW for hs485d: the same preamble on one port (through `LgwConnection`), then the binary
  transport frames (`0xFD`, length, payload with `0xFC` escapes) with the commands `K`, `D`, `S`, `L` and the answers
  `a`, `d`/`c`, `r` and `e` as hs485d expects them (HMWLGWCommand.h of OpenCCU-Base; Homegear's HMW-LGW.cpp read as
  documentation).
- `wired.js` - the bus behind it: `WiredDevice` from an `hs485types` description - the sysinfo for `h`/`v`, the serial
  for `n`, a 1 KiB EEPROM for `R`/`W`/`E`, the control-byte counters hs485d checks, key events, INFO_LEVEL after a
  set, the announcement - and `WiredBus`, which delivers frames and traces them.
- `eq3udp.js` - a simulated eQ-3 LAN device for the UDP device search (identify and the runtime IP configuration).
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
| hs485d | the `K` keepalive to the HMW-LGW                             | every 20 s (the thread's sleep), the answer within 700 ms, else a reconnect through the UDP search     |
| hs485d | a frame to a wired device (`S`)                              | `HS485_LGW_TIMEOUT` 200 ms in the frame, 700 ms for the gateway's answer, two tries                    |
| hs485d | discovery answers                                            | collected for 3 × 700 ms                                                                               |

A pty has no baud rate (115200 baud would be ~87 µs per byte), so the simulator is a faster module, never a slower one.
Node's event-loop latency is well under a millisecond for a heap this size - two to three orders of magnitude below
every window. Assertions on time use margins, never exact values. The delays the simulator itself uses (`DEFAULTS` in
`module.js`: 30 ms until "sent", 80 ms until an acknowledgement, 3 s until "failed") are **chosen**, not measured; a
calibration against a real module is planned.

### Measured against real hardware (2026-10-11)

**The HMW-LGW** (firmware 1.0.5) with an HMW-LC-Sw2-DR (firmware 3.06), hs485d 3.89.11 at log level 0: the connection
with the encrypted preamble takes ~5 ms; the `K` keepalive goes out every 20.0 s (19.98-20.00 s apart, the first ~20 s
after the connection) and is answered within a few ms; a `setValue` round trip at hs485d's RPC is 57-65 ms; the
switch reports its new state on its own (INFO_LEVEL) 2.9-3.0 s after a set; a discovery with one device ends 1.79 s
after the `D` (the whole `searchDevices` call 2.2 s: 0.2 s sleep-mode broadcast before and after). The simulator's
defaults follow: the bus answers in 45 ms, the device's status report comes 2950 ms after a set, the gateway closes a
discovery after 1750 ms and reports firmware 1.0.5. Not measured: what the gateway answers for a silent device (that
needs the device off the bus) - `a 01` stays chosen.

**The RPI-RF-MOD** (through multimacd, `/dev/mmd_bidcos`) with an HM-LC-Sw1-Pl-2, rfd 3.89.11 at log level 0: the
coprocessor answers a command in 0.2-0.6 ms; a switch command (CENTRAL_RAMP_START) is reported "Telegram sent, received
ACK" **155 ms** after rfd wrote it (155.1 and 155.2 ms); rfd polls `GETDUTYCYCLE` about every 26 s. The simulator's
defaults follow (`responseDelayMs` 1, `ackDelayMs` 155). So a real module manages about **6.5 switch commands per
second**, well below the 16.7 the airtime alone would allow (the module's listen-before-talk, its turnaround and the
multimacd hop). Not measured yet: a send to an absent device (`SEND_FAILED` timing - the device has to be unplugged),
a pairing, a duty-cycle event.

### Airtime and the duty cycle (computed, not measured)

For the load tests the air can model the channel itself (`new Air({module, airtime: {...}})`, `lib/airtime.js`). The
numbers come from the frame format of the public BidCoS implementations (culfw's and Homegear's CC1101 setup, read as
documentation): 2-FSK at 9992.6 baud (MDMCFG4/3 = 0xC8/0x93, 26 MHz), 4 bytes of preamble, the sync word twice
(4 bytes), the length byte, the telegram, 2 bytes of CRC - 0.8 ms per byte, so a switch command of 14 bytes takes
20.0 ms and its 14-byte answer as much; culfw waits 10 ms before it transmits, a burst telegram carries a 360 ms
wake-up preamble. One exchange (gap, command, gap, answer) is 60 ms: **at most ~16.7 switch commands per second** on
one module. The 868 MHz SRD sub-band allows a 1 % duty cycle - **36 s of the central's own airtime per hour, about
1800 such commands** (the ACKs count against the devices). The model serialises sends, meters the central's airtime
over a window (one hour, or scaled down for tests: the budget is always 1 % of it), reports it as the module's duty
cycle and refuses at 100 % with `SEND_FAILED_DUTYCYCLE` (chosen, as long as the module's check is on - rfd's
`setDutyCycleCheck(false)` is compiled out of its production build).

What rfd does with a flood (3.89.11 source, confirmed by the load tests): it sends synchronously - the RPC handler
waits in `CCU2CommController::sendBidcosTelegram` for the module's status (4 s) - so commands go out one exchange at a
time, in order, nothing is collapsed or dropped, and `setValue` answers after the ACK; received telegrams wait in the
interface's queue (1024 frames, the oldest dropped beyond) for the main loop. After two failed sends to a device
(also a duty-cycle refusal) rfd stops trying it until `FAIL_COUNTER_RESET_TIME` and answers further calls at once with
the fault "Failure".

One daemon behaviour worth knowing (now the finding `flush-drops-events`): rfd flushes its serial input before every command it sends, so an unsolicited
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

| Stage | Content                                                                                                                                                                                                             | State                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 0     | the docker image (release + ASan from an OpenCCU-Base ref), RPC black-box tests, libFuzzer harnesses                                                                                                                | done                   |
| 1a    | the simulated RPI-RF-MOD on a pty: init to `CONNECTED`, bootloader, `BUSY`, module lost and back, events, frame fuzzing                                                                                             | done                   |
| 1b    | the LAN gateway, plaintext: hmlangw in front of the pty module, rfd with `Type = HMLGW2`                                                                                                                            | done                   |
| -     | the test report: a Markdown summary per CI run and an HTML report on GitHub Pages with history and upstream links                                                                                                   | done                   |
| 2     | one simulated switch driven by the `rftypes` XML: pairing, set/ACK, status, UNREACH, CONFIG_PENDING, duty cycle; callback tests                                                                                     | done                   |
| 3     | a remote, the LAN gateway with the AES handshake and reconnect scenarios, AES devices, direct links, the module power-cycled behind the gateway                                                                     | done                   |
| 4     | hs485d against a simulated HMW-LGW with one wired actuator: discovery, sets, keys, EEPROM paramsets, a link, the keepalive timeout, a restart; the UDP device search for both daemons                               | done                   |
| 5     | multimacd in a VM with `eq3_char_loop` and the dual-coprocessor protocol                                                                                                                                            | to be refined          |
| -     | calibration of the module timing against a real RPI-RF-MOD                                                                                                                                                          | done                   |
| -     | calibration of the HMW-LGW timing against a real wired LAN gateway (hs485d)                                                                                                                                         | done                   |
| -     | the test report: the four result columns right-aligned and the same width in every table                                                                                                                            | done                   |
| -     | the test report: code coverage of rfd and hs485d from the suite                                                                                                                                                     | done                   |
| -     | upstream reports: `upstream-reports/` with one issue draft per daemon finding, nothing reported yet                                                                                                                 | done                   |
| -     | run the suite whenever OpenCCU-Base main moves: a 15-minute poll, the suite for that exact commit, noted on the report                                                                                              | done                   |
| -     | more daemon tests (the collection, split into the items below)                                                                                                                                                      | not as such            |
| -     | an RPC method sweep, a device-type sweep over all rftypes descriptions, the 3.89.11/main differential                                                                                                               | done                   |
| -     | the receiver contract: several receivers, init sync, event order, the unreachable rule, a stalled receiver                                                                                                          | done                   |
| -     | restart, device files and config: persistence, broken files, address donation, the start-up matrix                                                                                                                  | done                   |
| -     | `listMethods` tells the truth: every listed method is callable, and no callable method is missing                                                                                                                   | done                   |
| -     | a misbehaving event receiver blocks nothing: server gone mid-callback, no answer, wrong answers                                                                                                                     | done                   |
| -     | load: fast setValue/putParamset bursts, events meanwhile, rfd's queue, airtime and duty-cycle limits                                                                                                                | done                   |
| -     | lab measurements that need hands on a box: a silent wired device, a send to an absent BidCoS device, a pairing, a duty-cycle event                                                                                  | enqueued (preparation) |
| -     | three OpenCCU-Base variants side by side: the two newest tags and main's head, chosen automatically                                                                                                                 | in progress            |
| -     | prove the regression tests: each one run against the commit before its fix (fails there) and the fix itself (passes), marked "proven" on the report                                                                 | enqueued               |
| -     | serial read errors (#115/#116): a `read()` that really fails with ENODEV/EIO, so the tests reach the fixed code                                                                                                     | enqueued               |
| -     | LAN gateway, the rest of #13/#17: a failed restore after the reconnect, no telegrams meanwhile, the keepalive thread, a hello without serial, the status file, frames split across TCP segments, sockets above 1024 | enqueued               |
| -     | AES CBC-MAC frames (#4) from an HM-Sec-SD-2 smoke detector and the corrected `LONG_ACT_TYPE` register of the HM-OU-CFM-TW (#63)                                                                                     | enqueued               |
| -     | pin older fixes: hs485d's address and serial formats, files without a dot, unusual answers to libXmlRpc, the 49-day clock wrap (libfaketime)                                                                        | enqueued               |
| -     | firmware update flows with a simulated device (rfd) and the Hexfile path (hs485d)                                                                                                                                   | ready                  |
| -     | more fuzz targets: frames from a paired device, the frame, LGW, XML and device-file parsers                                                                                                                         | enqueued               |
| -     | a ThreadSanitizer image variant                                                                                                                                                                                     | enqueued               |
| -     | a wakeup/burst device: WOKEN_UP, the wakeup queue, burst, deferred delete                                                                                                                                           | done                   |
| -     | two interfaces: roaming, RSSI, `setBidcosInterface`, the duty-cycle bands                                                                                                                                           | testing                |

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
