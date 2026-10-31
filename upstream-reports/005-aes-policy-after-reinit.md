---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/165, fixed upstream: f5c583e9140e727cc9250fd80d934cf500596f74 (#211)
component: rfd
refs: [3.89.11 (3ed652a), main (030dba7)]
suite: aes-republish
---

# rfd does not restore the per-channel AES policy when it republishes devices after a coprocessor re-init

## What happens

When the coprocessor has to be initialised again while rfd runs - the LAN gateway reconnects after the module behind
it was power-cycled, or the module itself restarts - rfd goes through `IFSTATE_REINIT` and
`CCU2CommController::restoreConfigToCoprocessor()`, which calls `republishAllDevices()`. That re-adds every device
to the coprocessor (`ADD_LINK_PEER`) and sets the user keys again (`SET_CURRENT_AES_KEY`, `SET_PREVIOUS_KEY`), but
it does not set the per-device, per-channel authentication policy again (`AUTHENTICATION_ON` for the channels
whose `AES_ACTIVE` is on). The coprocessor starts with every channel off, so from then on it no longer authenticates
the events of those channels: a key press of a remote with AES arrives flagged "no authentication required" instead
of "authenticated", and rfd drops it, because the key parameters carry `auth_violate_policy="reject"`
(`PRESS_SHORT`, `PRESS_LONG` in `rf_rc.xml`; the same in the other remote and sensor descriptions). Commands to AES
devices keep working - there the device challenges and the coprocessor answers from the key table, which was
restored.

The policy comes back only when rfd restarts, or when the channel's configuration is written again
(`RFChannel::CommitPendingConfig()` → `UpdateAESFlag` → `SetDeviceAesPolicy`).

## How to reproduce

In the suite: `test/daemon/rfd-lgw-front.test.js`, "the module power-cycled behind the gateway" - an AES switch
and an HM-RC-4 paired through the encrypted LAN gateway; the gateway drops both ports, the simulated module forgets
its peers, keys and policy (as a power-cycled module does), the gateway comes back. rfd reconnects, logs
`Reconnected`, re-adds both devices and the keys; the module sees no `AUTHENTICATION_ON`; a key press on the remote
produces no `PRESS_SHORT` event. The two assertions run as `todo` under the name `aes-republish`.

On hardware: a CCU with an HM-LGW (or an RPI-RF-MOD behind hmlangw), a remote with AES active, pull the gateway's
power, plug it back in, press a key: no event until rfd is restarted.

## Expected

After `republishAllDevices()` the coprocessor holds the same state as after a fresh start of rfd: devices, keys and
the authentication channels of every device.

## Cause (public source)

`republishAllDevices()` only calls `AddDeviceRemote()` per device:
[CCU2BidcosRemoteInterface.cpp:492-511 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/hm2/CCU2BidcosRemoteInterface.cpp#L492-L511).
The policy is only sent from `CCU2BidcosRemoteInterface::SetDeviceAesPolicy()`
([:200-249](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/hm2/CCU2BidcosRemoteInterface.cpp#L200-L249)),
which compares the mask the coprocessor reports in the `ADD_LINK_PEER` answer with the one `BidcosInterface` keeps
for the device and sends `AUTHENTICATION_ON/OFF` for the channels that differ. The concentrator calls it when a
device is added or its key changes
([BidcosInterfaceConcentrator.cpp:211](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/BidcosInterfaceConcentrator.cpp#L211),
[:742](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/BidcosInterfaceConcentrator.cpp#L742)),
not on a re-init. The same on main
([CCU2BidcosRemoteInterface.cpp:492-511](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/CCU2BidcosRemoteInterface.cpp#L492-L511)).

## Proposed fix

In `republishAllDevices()`, after `AddDeviceRemote(address)` succeeded, apply the stored policy again:
`GetDeviceAesPolicy(address, &key, &channels)` (the data `BidcosInterface` already keeps per device) and then the
compare-and-send part of `SetDeviceAesPolicy()` (the coprocessor answered the mask in the `ADD_LINK_PEER` reply, so
the comparison is right there). Alternatively `SetDeviceAesPolicy(address, key, channels)` directly, at the cost of
one more `ADD_LINK_PEER` per device.
