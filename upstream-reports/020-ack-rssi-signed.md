---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/185, fixed upstream: efb620975ada689a24a26fcf21e0ff35d74df97e (#254)
component: rfd
refs: [3.89.11 (3ed652a), main (ee85651)]
suite: ack-rssi-sign
relevance: field # hits users: certain: every ACK of a BidCos-RF device to the central on an RPI-RF-MOD; RSSI_PEER and rssiInfo show impossible values
---

# rfd: the RSSI byte in the module's send status (the ACK) is signed; rfd negates it like the event's magnitude

## What happens

The RPI-RF-MOD reports the RSSI of a received telegram in two kinds of frames, in two formats (measured 2026-10-11
with an RPI-RF-MOD and rfd 3.89.11, a device at -20 and one at -40 dBm):

- the **event** frame (`BIDCOSCMD_EVENT`, `05`) carries the **magnitude**: `28` for -40 dBm;
- the **send status** frames `TELEGRAM_SENT_RECVD_ACK` (`04 … 03`) and `AUTHENTICATION_SUCCESS` (`04 … 0c`), which
  carry the device's acknowledgement, hold the RSSI as a **signed byte**: `d8` for -40 dBm, `ec` for -20 dBm.

rfd reads the byte the same way in both cases - `rssi = responseStr.at(5)` into an `int`, then
`frame.SetRSSI(-1 * rssi)` - so the ACK's RSSI comes out wrong, and differently per architecture, because
`std::string::at()` returns a `char`:

- on ARM (the CCU3 and the Raspberry Pi: `char` is unsigned) an ACK at -20 dBm becomes **-236** - rfd logs
  `RSSI=-236dB` for the ACK (`BidcosFrameDecoder`), at -40 dBm it is -216;
- on x86_64 (`char` is signed) the same ACK becomes **+20**, a positive field strength.

The value is not only logged. `BidcosInterfaceConcentrator::WaitResponses()` takes the response's RSSI into
`RFManager::UpdateRssiInfo()` (the second value of the device/interface tuple that `rssiInfo` returns, "what the
interface heard of the device's answer") and into `RFDevice::SetPeerRSSI()` (the device's `RSSI_PEER`). Both show
-216/-236 on a CCU3 and +40/+20 on x86_64 for a device at -40/-20 dBm, while the event's RSSI next to them is
correct.

## How to reproduce

In the suite: `test/daemon/rfd-switch.test.js`, "the ACK's RSSI: the module reports the status frame's RSSI as a
signed byte, rfd shows it in RSSI_PEER and rssiInfo (ack-rssi-sign)" (todo under the name `ack-rssi-sign`). The
simulated module sends the signed byte in its status frames and the magnitude in its events, as the real one does;
rfd (x86_64, 3.89.11 and main) answers `RSSI_PEER` 55 and `rssiInfo` `[-55, 55]` for a device at -55 dBm - the
event's value next to the ACK's.

On a CCU3: `rssiInfo` over XML-RPC, or rfd's log at level 0 after a `setValue`: the ACK line says `RSSI=-2xxdB`.

## Expected

The ACK's RSSI in dBm, like the event's: -20 for `ec`. The status frame's byte read as a signed value
(`(int8_t)responseStr.at(5)`, or `static_cast<signed char>`), without the negation - or, if the firmware's format
should be read as a magnitude, the byte read as `unsigned char` on every architecture; as it is, the result depends on
the compiler's `char`.

## Cause (public source)

- [CCU2CoprocessorCommand.cpp:282, 301, 342 at main](https://github.com/OpenCCU/OpenCCU-Base/blob/ee856515800f86f22f7e2cd9891ec3bb2e411fd3/src/rfd/hm2/CCU2CoprocessorCommand.cpp#L282):
  `rssi = responseStr.at(5)` for `AUTHENTICATION_SUCCESS`, `TELEGRAM_SENT_RECVD_ACK` and `EVENT` alike - a `char`
  into an `int`, signed or unsigned by architecture;
- [CCU2CommController.cpp:738](https://github.com/OpenCCU/OpenCCU-Base/blob/ee856515800f86f22f7e2cd9891ec3bb2e411fd3/src/rfd/hm2/CCU2CommController.cpp#L738):
  `frame.SetRSSI(-1 * bidcosCmd.getRSSI())` - the negation that fits the event's magnitude only;
- [BidcosInterfaceConcentrator.cpp:382-389](https://github.com/OpenCCU/OpenCCU-Base/blob/ee856515800f86f22f7e2cd9891ec3bb2e411fd3/src/rfd/BidcosInterfaceConcentrator.cpp#L382-L389):
  the response's RSSI goes into `UpdateRssiInfo()` and `SetPeerRSSI()`.

Unchanged since 3.89.11 (the same lines).

## Proposed fix

In `parseBidcosCommandResponse()`, read the RSSI of the two status cases as a signed byte and store it in dBm
(`rssi = static_cast<int8_t>(responseStr.at(5))`, no negation for these), and keep the magnitude handling for the
event; or let `getRSSI()` return dBm for every case so that `assembleBidcosFrame()` no longer negates. A value of 0
still means "unknown" (`INVALID_RSSI_VALUE`).
