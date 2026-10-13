---
status: draft
component: libUnifiedLanComm, rfd, hs485d
refs: [main (030dba7)]
suite: ulc-data-races
---

# libUnifiedLanComm: the connection state, the receive thread's stop and the hello handling race between the receive thread and the caller

## What happens

`UnifiedLanCommController` - the LAN-gateway transport both rfd (HM-LGW, `Type = HMLGW2`) and hs485d (HMW-LGW,
`-g`) use - keeps its connection state, the receive thread's stop flag and the thread's liveness in plain members that
one thread writes and another reads without a lock or an atomic. Under ThreadSanitizer (the suite's `tsan` variant,
gcc `-fsanitize=thread`, OpenCCU-Base main) every test that connects through a gateway reports data races in it:

- `handleHelloMessage()` (the receive thread) writes `connectionState` while `waitForState()` (the caller's thread,
  inside `connect()`) reads it in its wait loop;
- `stopReceiveThread()` (the caller) writes the stop flag and reads the thread's running state that the receive thread
  writes on its way out;
- `disconnect()` and the destructor touch the same members while the receive thread still runs; `LanConnection::
disconnect()` closes a socket the receive thread is reading.

On a run of the whole daemon suite under `tsan` on main: `stopReceiveThread` 30 reports, `handleHelloMessage` 28,
`waitForState` 2, `disconnect`, the destructor and `LanConnection::disconnect` one each, all from hs485d through the
simulated HMW-LGW; rfd through the HM-LGW shows the same `stopReceiveThread`/`handleHelloMessage`/`waitForState`
set (the suite's earlier runs of the #16 test).

These are not OpenCCU-Base #12 (the `pCommController` lifetime during the reconnect, fixed by #16) and not #6 (the
wrong variable in `stopBidcosChannelKeepAliveThread`, fixed by #13): they are the remaining unsynchronised state of the
controller itself, present before and after those fixes. What they do in practice: a `connect()` that waits for a
state the compiler is free to keep in a register, a stop that may miss the thread's exit - the kind of thing that
shows up as a reconnect that hangs or a shutdown that does not end, rarely and unreproducibly.

## How to reproduce

The suite's `tsan` variant (`docker build … --build-arg 'DAEMON_VARIANTS=release asan tsan'`, then `docker run
--security-opt seccomp=unconfined -e HMRS_VARIANT=tsan … npm run test:daemon`): any test of
`test/daemon/hs485d-lgw.test.js` or `test/daemon/rfd-lgw-front.test.js` leaves `tsan.*` reports next to the
daemon's log; the suite lists them as the finding `ulc-data-races` (they do not fail a test on a ref that lacks the
fix, a new race would). The daemons start without address randomisation (`setarch -R`), which docker's default
seccomp profile refuses - hence `seccomp=unconfined`.

## Expected

No data race: `connectionState` and the stop flag as `std::atomic`, or every access under the controller's mutex;
`stopReceiveThread()` joining the thread instead of polling a flag.

## Cause (public source)

[UnifiedLanCommController.cpp:154-452 at main](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/libUnifiedLanComm/src/UnifiedLanCommController.cpp#L154-L452):
`waitForState()` ([:172](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/libUnifiedLanComm/src/UnifiedLanCommController.cpp#L172))
reads `connectionState`, which `handleHelloMessage()` and the protocol steps write
([:310](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/libUnifiedLanComm/src/UnifiedLanCommController.cpp#L310),
[:352](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/libUnifiedLanComm/src/UnifiedLanCommController.cpp#L352),
[:383-387](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/libUnifiedLanComm/src/UnifiedLanCommController.cpp#L383-L387));
`stopReceiveThread()` ([:200](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/libUnifiedLanComm/src/UnifiedLanCommController.cpp#L200)).
The same on 3.89.11 (the library is unchanged there).

## Proposed fix

`std::atomic<ConnectionState> connectionState` and an atomic stop flag; `stopReceiveThread()` sets the flag, closes
the socket and joins; `waitForState()` on a condition variable the receive thread signals.
