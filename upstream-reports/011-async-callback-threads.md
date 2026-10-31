---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/171, fixed upstream: 002b8d13819335641e7e16a3c87a86175b904aa0 (#208)
component: libhsscomm (rfd, hs485d)
refs: [3.89.11 (3ed652a), main (030dba7)]
suite: async-callback-threads
---

# Every unanswered newDevices/deleteDevices/replaceDevice leaves a thread and a socket behind for good

## What happens

`HSSManager::XmlRpcCallAsync()` sends `newDevices`, `deleteDevices` and `replaceDevice` through an
`AsyncXmlRpcSender`: a new detached thread per call, which runs `XmlRpcClient::execute()` and deletes itself when
the call returns. The client has no timeout (`_timeout = -1`). A receiver that accepts these calls and never answers
keeps the thread and its socket alive for as long as it keeps the connection open - and every further `init` (or
device change) adds one more.

Measured with the suite (3.89.11 and main): ten `init` calls from a receiver that never answers `newDevices` -
rfd 3 → 14 threads and 9 → 19 fds, hs485d 6 → 16 threads and 10 → 19 fds, still there after 22 s. A logic layer that
re-registers periodically while hung (or a port that accepts and stalls) so grows the daemon by a thread and a socket
each time, until it runs out of either.

## How to reproduce

In the suite: `test/daemon/receiver-misbehaviour.test.js`, "a receiver that never answers newDevices leaves no
thread behind per init" (rfd and hs485d). Runs as `todo` under the name `async-callback-threads`.

## Expected

A timeout on the asynchronous callbacks (the event dispatcher uses 10 s), so a thread ends even when the receiver
does not answer.

## Cause (public source)

[AsyncXmlRpcSender.cpp:24-50 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libhsscomm/AsyncXmlRpcSender.cpp#L24-L50) (a detached thread per
call, `c.execute()` without a timeout); [XmlRpcClient.cpp:83](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libXmlRpc/src/XmlRpcClient.cpp#L83).
Unchanged on main (030dba79b5e76cb10178a20e87a1b050df09faa9).

## Proposed fix

`c.setTimeout(10000)` in the `AsyncXmlRpcSender` constructor (as `HSSXmlRpcEventDispatcher` does).
