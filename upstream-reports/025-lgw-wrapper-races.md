---
status: reported (the hs485d part only, rewritten): https://github.com/OpenCCU/OpenCCU-Base/issues/195
component: rfd, hs485d
refs: [main (030dba7)]
suite: lgw-wrapper-races
relevance: rare # rare: the hs485d part (#195): rare per installation, but possible on every installation with an HMW-LGW - a missed keepalive while a send is under way; the rfd part is harmless
---

# LGWPortWrapper (rfd and hs485d): the last-communication timestamp, the keepalive stop flags and the reconnect state are plain variables shared between threads

## What happens

rfd's `HM2::LGWPortWrapper` (the HM-LGW port behind the coprocessor controller) keeps
`timestampLastBidcosCommunication`, the two keepalive threads' active flags and `reconnectPending` as `volatile`
members; `volatile` orders nothing between threads. Under ThreadSanitizer (the suite's `tsan` variant on OpenCCU-Base
main) the receive thread's `ReadData()` writes the timestamp (`LGWPortWrapper.cpp:108`) while the keepalive thread
and the caller read and write it; `stopBidcosChannelKeepAliveThread()` writes a flag the keepalive thread polls
(the suite's earlier runs of the #16 test: 37 reports of `ReadData`, one of the stop). hs485d's own
`LGWPortWrapper` has the same shape: `reconnect()` and `SendData()` race on the connection state (one report each
on a full run).

OpenCCU-Base #6 was the wrong variable in `stopBidcosChannelKeepAliveThread` (fixed by #13) and #12 the
`pCommController` lifetime in the reconnect (fixed by #16); the races here are the shared variables around them, on
main after both fixes. What they mean in practice: a keepalive timer that reads a stale timestamp (a reconnect that is
not needed, or one that is), a stop flag the thread never sees.

## How to reproduce

The suite's `tsan` variant on a ref of main: the LAN-gateway tests of `test/daemon/rfd-lgw-front.test.js`,
`test/daemon/rfd-lgw-recovery.test.js` and `test/daemon/hs485d-lgw.test.js` leave `tsan.*` reports next to the
daemon's log, listed as the finding `lgw-wrapper-races`.

## Expected

No data race: the timestamp and the flags as `std::atomic`, or read and written under the wrapper's mutex.

## Cause (public source)

rfd: [LGWPortWrapper.h:111-134 at main](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/LGWPortWrapper.h#L111-L134)
(`volatile bool keepAliveThreadActive`, `volatile bool bidcosChannelKeepAliveThreadActive`,
`volatile uint64_t timestampLastBidcosCommunication`, `volatile bool reconnectPending`), written in `ReadData()`
([LGWPortWrapper.cpp:108](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/LGWPortWrapper.cpp#L108))
and at the connect ([:65](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/LGWPortWrapper.cpp#L65)).
hs485d: [LGWPortWrapper.cpp:71 (SendData) and :161 (reconnect) at main](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/hs485d/LGWPortWrapper.cpp#L161).

## Proposed fix

`std::atomic<uint64_t>` for the timestamp, `std::atomic<bool>` for the flags (as #116 did for `readError`), the
reconnect state under the existing mutex.
