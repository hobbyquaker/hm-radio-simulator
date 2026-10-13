---
status: draft
component: rfd
refs: [main (030dba7)]
suite: copro-request-races
---

# The coprocessor request slot is read outside its lock, the response command is copied into it under a race, and handleIncomingResponse locks a mutex it holds

## What happens

`CCU2CommController` (rfd's coprocessor protocol, every interface type) keeps one `RequestInfo` per request kind -
system command, BidCoS request, BidCoS telegram - with the response command and a status. The serial receive thread
fills the slot in `handleIncomingResponse()`, the caller's thread waits for it in `waitForCoProcessorResponse()` and
reads it afterwards. Under ThreadSanitizer (the suite's `tsan` variant on OpenCCU-Base main) the ordinary traffic of
the suite - the sweeps, the pairing, a switch - reports:

- `handleIncomingResponse()` reads `responseStatus` of the three slots before it takes the slot's mutex
  (`CCU2CommController.cpp:468`, `:498`, `:541`), against the caller's writes under the lock;
- the response command is copied into the slot (`CCU2CoprocessorCommand::operator=`, the copy constructor, down to
  `memcpy` in the strings) while the caller copies it out: 7 + 6 + 2 reports on a full run, 10 in
  `waitForCoProcessorResponse()`, 4 in `sendSystemCommand()`, 2 in `internalSendBidcosRequest()`;
- "double lock of a mutex" in `handleIncomingResponse()` (2 reports): a slot's mutex taken a second time on the same
  thread - with a non-recursive `pthread_mutex_t` that is a deadlock, with a recursive one a sign that the locking
  does not nest the way it is meant to.

This is the area of #179 (`system-command-slot`: two system commands from two threads share one slot and one takes
the other's answer); the races here are what ThreadSanitizer sees of the same design on a single request.
`handleIdentifyEvent()` (the module's identify announcement on the receive thread) reports the same kind of race on
the coprocessor state against the initialising caller (5 reports on the pty tests).

## How to reproduce

The suite's `tsan` variant on a ref of main: `test/daemon/rfd-sweep.test.js`, `test/daemon/rfd-switch.test.js`
and most other rfd tests leave `tsan.*` reports next to the daemon's log, listed as the finding
`copro-request-races`.

## Expected

No data race and no double lock: the status read under the slot's mutex (or atomic), the response copied under the
lock the waiter also holds, one lock per slot per thread.

## Cause (public source)

[CCU2CommController.cpp:461-550 at main](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/CCU2CommController.cpp#L461-L550)
(`handleIncomingResponse`: the unlocked reads at [:468](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/CCU2CommController.cpp#L468),
[:498](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/CCU2CommController.cpp#L498),
[:541](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/CCU2CommController.cpp#L541),
the locks at [:474](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/CCU2CommController.cpp#L474),
[:504](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/CCU2CommController.cpp#L504),
[:544](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/CCU2CommController.cpp#L544));
`sendSystemCommand` ([:247-300](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/CCU2CommController.cpp#L247-L300));
the slots ([CCU2CommController.h:128-193](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/CCU2CommController.h#L128-L193)).
The same code is on 3.89.11.

## Proposed fix

Take the slot's mutex before reading its status in `handleIncomingResponse()`; copy the response under that mutex and
let the waiter copy it out under the same one; one request object per call instead of a shared slot would also close
#179.
