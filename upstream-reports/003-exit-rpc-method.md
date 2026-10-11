---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/163
component: rfd
refs: [3.89.11 (3ed652a), main (030dba7)]
suite: -
---

# The RPC method `exit` is always compiled in: any client that reaches rfd's port can stop it

## What happens

rfd registers an XML-RPC/BIN-RPC method `exit`. Calling it sets the main loop's `run` flag to false; rfd shuts down
and exits with code 0. Every client that can reach rfd's port (2001 on a CCU) can do that, without a parameter and
without authentication. The source's own comment says the method should only be compiled in when the shutdown is
being debugged, but the `#ifdef DEBUG_SHUTDOWN` around it is commented out.

On OpenCCU, monit restarts rfd, so the effect is a restart of the BidCoS interface with everything that goes with
it (reinitialising the module, republishing the devices, dropped events); on a system without a supervisor rfd stays
down.

## How to reproduce

Against a running rfd (here the suite's, any port works):

```sh
curl -s -X POST -H 'Content-Type: text/xml' \
  --data '<?xml version="1.0"?><methodCall><methodName>exit</methodName><params/></methodCall>' \
  http://127.0.0.1:2001/
```

rfd logs `XmlRpc_exitCommand: -> shutting rfd down` and exits with 0.

## Expected

No `exit` method in a production build - or one that is switched on deliberately (a build option or a config key),
as the comment in the source intends.

## Cause (public source)

[rfd.cpp:73-89 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/rfd.cpp#L73-L89)
(the same on [main](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/rfd.cpp#L74-L89)):
`//#ifdef DEBUG_SHUTDOWN` ... `class XmlRpcMethodExit` ... `//#endif` - the guard is a comment, so `xmlRpcMethodExit`
is a static object in every build.

## Proposed fix

Restore the `#ifdef DEBUG_SHUTDOWN` guard (and define it in the debug build only), or make the method depend on a
configuration key that defaults to off. A test suite that wants a clean shutdown can use a signal handler instead
(see 004).
