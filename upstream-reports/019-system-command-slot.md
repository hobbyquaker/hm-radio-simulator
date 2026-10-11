---
status: draft
component: rfd
refs: [3.89.11 (3ed652a), main (570566e)]
suite: system-command-slot
---

# rfd: two coprocessor system commands from two threads share one request slot; one takes the other's answer

## What happens

`CCU2CommController::sendSystemCommand()` keeps the pending request in one member, `systemCommandRequestInfo`, guarded
by `mutexSystemCommandRequest`. It waits for the answer with `pthread_cond_timedwait()` on that same mutex - and the
wait releases the mutex. A second thread that sends a system command meanwhile (the RPC thread, the start-application
thread after a module restart, the LAN gateway's keepalive or recovery threads) gets the mutex, overwrites the
request and sets the state back to waiting. The receive thread then matches the next answer against the second
request only; whichever thread the condition wakes takes that answer as its own, and the other one times out or reads
an answer that belongs to another command.

Measured with rfd 3.89.11 and main, a simulated module behind the HM-LGW front, the module answering `GETDUTYCYCLE`
after 900 ms (within rfd's 1000 ms window) and announcing a restart (bootloader identify) while
`listBidcosInterfaces` waits for that answer:

- rfd's start-application thread sends `STARTBOOTLOADER` 500 ms later, answered at once;
- the duty-cycle query gets the `STARTBOOTLOADER` answer: "getDutyCycle(): Response empty", `DUTY_CYCLE` is -1 in
  `listBidcosInterfaces`;
- the restore after the restart then fails once ("Restoring coprocessor configuration failed. Retrying.") because its
  first command meets the late `GETDUTYCYCLE` answer.

The same was first seen during a LAN-gateway reconnect: a slow `SET_CLOCK` of the restore was "answered" by the reply to
a concurrent `GETDUTYCYCLE`, so the restore counted as successful while `SET_CLOCK` had not been answered yet, and
the duty-cycle query timed out ("Could not get DutyCycle from coprocessor").

A real module answers within a millisecond, so the window is small on a UART; behind a LAN gateway or a busy
multimacd an answer takes longer, and every `listBidcosInterfaces` (a WebUI polls it) sends a system command from the
RPC thread.

## How to reproduce

In the suite: `test/daemon/rfd-lgw-recovery.test.js`, "two coprocessor system commands at once: each gets its own
answer (a duty-cycle query while the module restarts)" (todo under the name `system-command-slot`).

## Expected

Each system command gets its own answer: a second command waits until the first one is finished (or the answers are
matched by the frame counter to the request that sent it).

## Cause (public source)

- [CCU2CommController.cpp:247-303 at main](https://github.com/OpenCCU/OpenCCU-Base/blob/570566e3fa0979698b83d0b6714997f78e8f9979/src/rfd/hm2/CCU2CommController.cpp#L247-L303):
  `sendSystemCommand()` locks `mutexSystemCommandRequest`, writes `systemCommandRequestInfo.requestCmd` and
  `responseStatus = RESPONSE_WAIT`, sends, then calls `waitForCoProcessorResponse()`.
- [CCU2CommController.cpp:997-1014](https://github.com/OpenCCU/OpenCCU-Base/blob/570566e3fa0979698b83d0b6714997f78e8f9979/src/rfd/hm2/CCU2CommController.cpp#L997-L1014):
  `pthread_cond_timedwait(waitCondition, mutex, ...)` - the mutex is free while the thread waits.
- [CCU2CommController.cpp:540-560](https://github.com/OpenCCU/OpenCCU-Base/blob/570566e3fa0979698b83d0b6714997f78e8f9979/src/rfd/hm2/CCU2CommController.cpp#L540-L560):
  the receive thread compares the answer with the one `requestCmd` in the slot and signals one waiter.

Unchanged since 3.89.11. `sendBidcosRequest()` (`internalSendBidcosRequest()` with `bidcosRequestInfo`) waits the same
way and probably has the same problem; this suite has not tested it.

## Proposed fix

Serialise system commands with a separate mutex that is held for the whole exchange (send, wait, read the result),
e.g. `pthread_mutex_lock(&mutexSystemCommandExchange)` at the start of `sendSystemCommand()` and unlock at its end,
keeping `mutexSystemCommandRequest` for the slot and the condition. The same for `sendBidcosRequest()`.
