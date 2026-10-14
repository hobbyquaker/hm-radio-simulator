---
status: draft
component: rfd
refs: [3.89.11 (3ed652a), main (df07a0e)]
suite: devices-lock-wait
relevance: rare # rare: rare on a local radio module (a few ms window per command), more often on an HM-LGW and in event bursts: a 1-2 s stall of rfd's RPC loop, nothing lost
---

# The device lock is held while a coprocessor command waits for its answer; the receive thread blocks on it and the answer times out

## What happens

`BidcosInterfaceConcentrator::AddDevice()` and `SetDeviceAesPolicy()` lock `mutex_devices` and, still holding it, call
the interface (`ADD_LINK_PEER`, then the AES policy: `AUTHENTICATION_OFF`/`ON` per channel). On the coprocessor
interfaces that is `CCU2CommController`, which sends the command and waits up to `coproCommandTimeout` (1000 ms) for the
module's answer. The answer can only be read by the serial receive thread. That thread hands every BidCoS event to
`BidcosInterfaceConcentrator::ProcessReceivedFrame()`, which locks `mutex_devices` first for every frame addressed to
the central. A frame for the central that the receive thread reads after the command went out parks the thread on the
mutex. The answer stays unread, the command times out ("waitForCoProcessorResponse(): Timeout while waiting for
response", "Adding device remotely failed", "Error disabling channel authentication"), and the next command under the
same lock (the AES policy after `ADD_LINK_PEER`) times out as well. The module did answer; rfd reads the answers only
after the lock is released and handles them as stray events.

Each such stall takes 1 s per command. It also blocks the RPC server: the frames are processed on the XmlRpc main loop,
which is the thread that is waiting.

Measured with rfd 3.89.11 and main, a simulated module on a pty:

- A paired HM-LC-Sw1-Pl sends its sysinfo outside install mode. rfd adds the device to the module again (one
  `ADD_LINK_PEER` and one AES policy per sysinfo). The module answers `ADD_LINK_PEER` after 300 ms. A status telegram
  from the switch arrives 100 ms after the command. rfd times out on `ADD_LINK_PEER` and then on the AES policy, and
  the status event is delivered about 2 s late (1.9 s measured). This happens in every run, with and without the
  flush below, because the frame arrives after the command was written.
- 400 telegrams with mutated content from the paired switch (about 65 of them sysinfo) gave 0 to 33 timeouts per run,
  depending on how the frames fell around rfd's commands. In the worst run rfd took more than 30 s to answer a
  `setValue` that came after the telegrams.

On a pty, the `tcflush()` that rfd did before every command (OpenCCU-Base #173) used to discard most of these frames
and so hid the effect. On `/dev/mmd_bidcos` and `/dev/raw-uart` that flush was always a no-op, so systems running rfd
through multimacd or the raw UART driver have this window as it is. The window is short when the module answers within
a millisecond. It grows when the answer takes longer (through multimacd, a LAN gateway, a busy module), and whenever
several frames for the central arrive around a command (a burst of events, a device that sends its sysinfo).

## How to reproduce

In the suite: `test/daemon/parsers.test.js`, "a frame for the central while rfd re-adds a paired device after its
sysinfo does not cost module timeouts" and the subtest "the device answers setValue within 30 s afterwards" of the
mutated-telegram test. Both run as todo under the name `devices-lock-wait`.

## Expected

A coprocessor command does not wait for its answer while it holds a lock that the receive thread needs before it can
read on. Possible ways: release `mutex_devices` around the interface call (copy what is needed), or do not take
`mutex_devices` on the receive thread (queue the frame and update the counters on the main loop). The module's answer
then arrives within its time, and events are not held back.

## Cause (public source)

- [BidcosInterfaceConcentrator.cpp:687-727 at main](https://github.com/OpenCCU/OpenCCU-Base/blob/df07a0ec4e956e65f7c14cc96364e738245220cc/src/rfd/BidcosInterfaceConcentrator.cpp#L687-L727):
  `AddDevice()` locks `mutex_devices` and calls `RemoveDeviceFromInterface()` and `AddDeviceToInterface()` →
  `BidcosInterface::AddDevice()` and `SetDeviceAesPolicy()` under it.
- [BidcosInterfaceConcentrator.cpp:742-764](https://github.com/OpenCCU/OpenCCU-Base/blob/df07a0ec4e956e65f7c14cc96364e738245220cc/src/rfd/BidcosInterfaceConcentrator.cpp#L742-L764):
  `SetDeviceAesPolicy()` the same. `AddDeviceWakeupRequest()` and the other device methods that follow have the same
  shape.
- [BidcosInterfaceConcentrator.cpp:241-254](https://github.com/OpenCCU/OpenCCU-Base/blob/df07a0ec4e956e65f7c14cc96364e738245220cc/src/rfd/BidcosInterfaceConcentrator.cpp#L241-L254):
  `ProcessReceivedFrame()`, called on the receive thread, locks `mutex_devices` for every frame addressed to the
  central (to update the device's counter).
- [CCU2CommController.cpp:390-431](https://github.com/OpenCCU/OpenCCU-Base/blob/df07a0ec4e956e65f7c14cc96364e738245220cc/src/rfd/hm2/CCU2CommController.cpp#L390-L431):
  `handleIncomingEvent()` calls `pBidcosRemoteInterfcace->handleEvent(frame)` → `ProcessReceivedFrame()` on the
  receive thread, before the thread reads the next frame (the answer).
- [CCU2CommController.cpp:997-1014](https://github.com/OpenCCU/OpenCCU-Base/blob/df07a0ec4e956e65f7c14cc96364e738245220cc/src/rfd/hm2/CCU2CommController.cpp#L997-L1014):
  `waitForCoProcessorResponse()` waits `coproCommandTimeout` = 1000 ms
  ([line 41](https://github.com/OpenCCU/OpenCCU-Base/blob/df07a0ec4e956e65f7c14cc96364e738245220cc/src/rfd/hm2/CCU2CommController.cpp#L41)).

Unchanged since 3.89.11. Where rfd calls the re-add after a sysinfo outside install mode was not traced here: one
`ADD_LINK_PEER` and one AES policy per sysinfo is what was measured.
