---
status: draft
component: rfd
refs: [3.89.11 (3ed652a), main (030dba7), lite (632cf5d)]
suite: update-nack-ignored
relevance: edge # rare edge case: practically never: eQ-3's files match their type, a frame corrupted on air gets no answer, and no eQ-3 bootloader is known to NACK an update frame
---

# A device's NACK to a firmware update frame counts as delivered: the OTAU ends as a success and the device is rebuilt

## What happens

During a firmware update (`updateFirmware`), rfd sends every update frame of the `.eq3` file to the device in
chunks and waits for the device's acknowledgement of the last chunk (`BidcosInterfaceConcentrator::SendUpdataFrame`).
When the device answers that chunk with a NACK (`02 80`) - a file for another device type, a frame whose checksum
does not fit, a bootloader that refuses the image - rfd takes the answer as the acknowledgement: `SendUpdataFrame`
returns true, `RFDevice::UpdateFirmware` goes on with the next frame, and at the end it calls `Rebuild()`, which gives
the device the version from `fwmap` and announces it anew with `newDevices` (or `updateDevice`). `updateFirmware`
returns `true`.

The device, however, still runs its old firmware - or sits in its bootloader at 100 kbit/s waiting for a good image.
rfd now believes `FIRMWARE` is the new version, `DEVICE_IN_BOOTLOADER` is 0 and no update is pending; a later
`updateFirmware` starts the bootloader again at 10 kbit/s, where a device left in its bootloader does not listen,
and ends with "Bootloader in device … didn't start".

## How to reproduce

In the suite: `test/daemon/rfd-firmware.test.js`, "a file the device refuses (another type, a bad CRC): the NACK is
not an acknowledgement (update-nack-ignored)". The simulated HM-LC-Sw2PBU-FM (rf_s_2conf_644.xml, `updatable="true"`)
is paired, a user firmware whose first frame names another device type is deployed and `updateFirmware` is called:
the device NACKs every frame, rfd logs "Firmwareupdate completed", returns `true`, reports `FIRMWARE = 2.12` while the
device announces 2.9 and sits in its bootloader; the same with a frame whose checksum is wrong. Runs as `todo` under
the name `update-nack-ignored`; measured on 3.89.11, main and the fork's `lite`, release and ASan.

## Expected

A NACK (or no acknowledgement) to an update frame is a failed send: the retry logic of `SendUpdataFrame` runs (four
tries), and the update ends with -9 "Device is out of range" on the first frame or "Firmware update aborted" on a
later one, `UPDATE_PENDING` set as for every other failure - the device keeps its version in rfd, and the next attempt
starts from the bootloader the device is actually in.

## Cause (public source)

[BidcosInterfaceConcentrator.cpp:479-610 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/BidcosInterfaceConcentrator.cpp#L479-L610):
`retVal` is set to true once ([:507](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/BidcosInterfaceConcentrator.cpp#L507))
and never cleared; after each chunk the function waits with `CheckReceiveComplete` and returns `retVal`
([:610](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/BidcosInterfaceConcentrator.cpp#L610))
without looking at the response - `BidcosFrame::CheckReceiveComplete` is true for any response
([BidcosFrame.cpp:154](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/BidcosFrame.cpp#L154)),
a NACK included, and the module reports a NACK as "Telegram sent, received ACK" with the NACK telegram in the data.
The only failure the caller sees is `iface->SendFrame()` returning false (no answer at all,
[:537](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/BidcosInterfaceConcentrator.cpp#L537),
[:580](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/BidcosInterfaceConcentrator.cpp#L580)).
`RFDevice::UpdateFirmware` ([RFDevice.cpp:1534-1551](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/RFDevice.cpp#L1534-L1551))
retries only on that false. The bootloader start, by contrast, does check `response->IsNack()`
([RFDevice.cpp:1510](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/RFDevice.cpp#L1510)).
Unchanged on main ([BidcosInterfaceConcentrator.cpp:479-610](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/BidcosInterfaceConcentrator.cpp#L479-L610)).

## Proposed fix

In `SendUpdataFrame`, after the wait for the final chunk: `if (rfUpdateFrame.WasNacked() || !rfUpdateFrame.GetResponse(0)) retVal = false;`
(and the same for the chunks inside the loop that carry BIDI, should any), so that `UpdateFirmware`'s retry and its
-9 / "aborted" paths apply to a refused frame as well.
