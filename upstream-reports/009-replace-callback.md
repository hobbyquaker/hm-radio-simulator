---
status: draft
component: rfd, hs485d
refs: [3.89.11 (3ed652a), main (030dba7)]
suite: replace-callback
---

# A logic layer that was not connected when a device was replaced learns it as deleted

## What happens

When a device is replaced (`replaceDevice(old, new)`), the receivers registered at that moment get
`replaceDevice(id, old, new)` - that works in both daemons. A receiver that registers later and still lists the old
device in its `listDevices` answer should get the same call from the init sync (`HSSManager::PlatformInit()` asks
`IsDeviceReplaced(old, &new)` for every address the receiver knows and the daemon does not, if the receiver lists
`replaceDevice` in `system.listMethods`). Instead it gets `deleteDevices(id, [old])`, in both daemons, for
different reasons:

- **rfd:** `RFManager::IsDeviceReplaced()` finds the old serial in its replace history and fills in the new one, but
  returns `false` in every case.
- **hs485d:** `HS485Device::replaceDevice()` takes over the new device's identity (`SetSerial(newDevice->serial)`)
  and only then stores "the old serial" in its replacement history - `this->serial` is the new one by then. And
  `HS485Manager::initReplacementHistory()`, which builds the lookup `IsDeviceReplaced()` reads, runs only at start-up,
  so even a correct entry would be found only after a restart.

A logic layer that was offline during the replacement (restarted, or a second one such as a backup or a bridge) so
deletes the old device and creates the new one from scratch, losing the names, rooms, programs and links it kept for
it - which is what `replaceDevice` exists to prevent.

## How to reproduce

In the suite: `test/daemon/receiver-contract.test.js`, "replaceDevice - a receiver that still lists the old device
gets replaceDevice(old, new) at init" for rfd (two virtual HM-LC-Sw1-Pl) and hs485d (two simulated HMW-LC-Sw2-DR on
the HMW-LGW in JavaScript): `replaceDevice` answers `true`, then a receiver that lists `replaceDevice` and the old
device registers - it gets `deleteDevices([old])` and no `replaceDevice`. The tests run as `todo` under the name
`replace-callback`. The test before them shows that receivers registered during the replacement are told.

## Expected

`replaceDevice(id, old, new)` at init for a receiver that still knows the old device, and no `deleteDevices` for it.

## Cause (public source)

- rfd: [RFManager.cpp:1560-1568 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/RFManager.cpp#L1560-L1568) (`return false;` after the
  lookup); unchanged on main ([:1560-1568](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/RFManager.cpp#L1560-L1568)).
- hs485d: [HS485Device.cpp:1069-1073](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/HS485Device.cpp#L1069-L1073) (the history entry after
  `SetSerial`), [HS485Manager.cpp:144-156](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/HS485Manager.cpp#L144-L156) called only from
  [:263](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/HS485Manager.cpp#L263); unchanged on main.
- The caller: [HSSManager.cpp:318-336](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libhsscomm/HSSManager.cpp#L318-L336). Note that it sends the
  `replaceDevice` without a url (`XmlRpcCallAsync("replaceDevice", params)`), i.e. to every registered receiver, not
  only to the one that called `init`.

## Proposed fix

rfd: `return true;` inside the `if` of `IsDeviceReplaced()`. hs485d: store the old serial before `SetSerial()` and
refresh the lookup after a replacement (`initReplacementHistory()` at the end of `ReplaceDevice()`). In
`PlatformInit()`, pass the receiver's url to `XmlRpcCallAsync("replaceDevice", ..., url)`.
