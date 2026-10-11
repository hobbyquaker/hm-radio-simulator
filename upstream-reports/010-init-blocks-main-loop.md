---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/170
component: libhsscomm, libXmlRpc (rfd, hs485d)
refs: [3.89.11 (3ed652a), main (030dba7)]
suite: init-blocks
---

# init with a receiver that does not answer freezes the whole daemon

## What happens

`init(url, id)` makes the daemon call the receiver back before it answers: `HSSManager::PlatformInit()` calls
`system.listMethods` and `listDevices` on it through `HSSManager::XmlRpcCallSync()`. That runs inside the RPC
handler, i.e. on the daemon's single main loop - the same `XmlRpcServer::work()` loop that serves every other RPC
client, runs the timers and (rfd: the interface concentrator is a source of the same dispatcher; hs485d: the bus
controller) reads the radio side. The `XmlRpcClient` it uses has no timeout (`_timeout = -1`, "wait forever until
an event arrives").

So a receiver that accepts the connection and never answers - a hung logic layer, a half-dead process, a port
forwarded to something that accepts and stalls, an address whose TCP connect hangs - stops the daemon completely:
no other client gets an answer, no events reach the other receivers, timers do not run, and the radio side is not
read, until that connection closes. Measured with the suite on rfd and hs485d (3.89.11 and main): while a receiver
keeps `system.listMethods` unanswered, `ping` from another client gets no answer for as long as the test waits,
and the other receiver gets nothing; when the receiver closes the connection, everything resumes.

## How to reproduce

In the suite: `test/daemon/receiver-misbehaviour.test.js`, "init with a receiver that never answers blocks nothing"
(rfd and hs485d) - a raw receiver accepts and reads `system.listMethods`, never answers. Runs as `todo` under the
name `init-blocks`. By hand: `nc -l 9999` (reads, never answers), then `init("xmlrpc_bin://127.0.0.1:9999", "x")`
from one client and any call from a second client.

## Expected

The init callbacks with a timeout (as the event dispatcher has, 10 s), or off the main loop, so that a broken
receiver costs only its own registration.

## Cause (public source)

- [HSSManager.cpp:132](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libhsscomm/HSSManager.cpp#L132) `XmlRpcCallSync` - a plain `XmlRpcClient`,
  called from `PlatformInit()` at [:255](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libhsscomm/HSSManager.cpp#L255) and
  [:281](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libhsscomm/HSSManager.cpp#L281) (and `CommitReplacedDevices()` at
  [:201](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libhsscomm/HSSManager.cpp#L201));
- [XmlRpcClient.cpp:83](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libXmlRpc/src/XmlRpcClient.cpp#L83), [:104](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libXmlRpc/src/XmlRpcClient.cpp#L104)
  (`_timeout = -1`) and [:196](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libXmlRpc/src/XmlRpcClient.cpp#L196) (`_disp.work(_timeout)`);
- the single loop: [rfd.cpp:395-402](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/rfd.cpp#L395-L402), [hs485d.cpp:407](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/hs485d.cpp#L407),
  [:425](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/hs485d.cpp#L425). Unchanged on main (030dba79b5e76cb10178a20e87a1b050df09faa9).

## Proposed fix

`c.setTimeout(...)` in `XmlRpcCallSync()` (the dispatcher's 10 000 ms would do), and a connect timeout in
`XmlRpcClient::setupConnection()`.
