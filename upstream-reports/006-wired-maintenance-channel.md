---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/166
component: hs485d
refs: [3.89.11 (3ed652a), main (030dba7)]
suite: wired-maintenance
relevance: field # hits users: plausible on every wired installation: from learning a device until the next restart of hs485d (often months) its bus failure raises no UNREACH
---

# hs485d: a newly discovered wired device has no working maintenance channel until hs485d restarts

## What happens

When hs485d finds a wired device - through `searchDevices` or the device's own announcement - it builds the device's
channels with `HS485Device::SetDeviceDescription()`, which creates every channel as a plain `HS485Channel`
(`CreateChannel()`), ignoring the `class="maintenance"` of channel 0 in the device description. The maintenance
values are then not reachable:

- `getValue(<serial>:0, "UNREACH")`, `"STICKY_UNREACH"` and `"CONFIG_PENDING"` land in `HS485Channel::GetInternalValue()`,
  log `Tried to get unknown internal value UNREACH` and answer `false`, whatever the device's state;
- when a send to the device fails, `HS485Device::SendMessage()` sets its `FLAG_UNREACH`/`FLAG_STICKY_UNREACH` and calls
  `SendInternalValueEvent("UNREACH")`, but no channel has registered for the device's internal values (only
  `HS485MaintenanceChannel` does), so no `UNREACH`/`STICKY_UNREACH` event reaches the logic layer and no service
  message appears.

After a restart of hs485d the device is loaded from its `.dev` file, and that path (`LoadFromXml()` →
`AddChannel(index, type)`) honours the class: channel 0 becomes an `HS485MaintenanceChannel`, `UNREACH` reads the
device's flag and the events fire. So the service messages of a wired device start working only with the next
restart of hs485d after it was learned in.

## How to reproduce

In the suite: `test/daemon/hs485d-lgw.test.js`, "a silent device" - a simulated HMW-LC-Sw2-DR on the HMW-LGW in
JavaScript; after the discovery the device stops answering, a `putParamset` makes the EEPROM write fail
(`HS485EEPromCache::Flush() WriteChunk(0) failed`): `getValue(":0", "UNREACH")` logs the warning and stays `false`,
the receiver gets no event. The two assertions run as `todo` under the name `wired-maintenance`. The test "restart"
shows the other side: the same device after a restart of hs485d, loaded from its file, reports `UNREACH = true`,
`STICKY_UNREACH = true` and both events when the write fails.

On a CCU: learn in a wired device, unplug it from the bus, trigger a configuration write - no service message until
hs485d is restarted (a reboot), then the message appears at the next failed write.

## Expected

The channels of a freshly discovered device are built like those of a loaded one: with the channel class from the
description, so that the maintenance channel works from the first minute.

## Cause (public source)

[HS485Device.cpp:401-420 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/HS485Device.cpp#L401-L420)
(`SetDeviceDescription`, `CreateChannel()` for every channel) versus
[HS485Device.cpp:369-399](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/HS485Device.cpp#L369-L399)
(`AddChannel`, which creates `channel_class_<class>` through the type registry) used from `LoadFromXml()` at
[:536-548](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/HS485Device.cpp#L536-L548).
The same on main
([HS485Device.cpp:401-420](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/hs485d/HS485Device.cpp#L401-L420)).
`HS485Channel::GetInternalValue()` knows only `BEHAVIOUR`
([HS485Channel.cpp:554-566](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/HS485Channel.cpp#L554-L566)).

## Proposed fix

In `SetDeviceDescription()`, create each channel through `AddChannel(j+start, ch_desc->GetType())` (or the same
class lookup inline) instead of `CreateChannel()`, so a discovered device gets its `HS485MaintenanceChannel` like a
loaded one. `ReplaceDevice`'s channel creation at HS485Device.cpp:893-910 has the same shape.
