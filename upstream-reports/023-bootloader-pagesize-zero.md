---
status: draft
component: hs485d
refs: [3.89.11 (3ed652a), main (030dba7), lite (632cf5d)]
suite: bootloader-pagesize-zero
---

# hs485d dies with SIGFPE when a wired device's bootloader answers the page-size request with 0

## What happens

During a wired firmware update (`updateFirmware`), `HS485Device::WriteFlash()` asks the device's bootloader for its
page size (`p`) and takes the two answer bytes as `pagesize`. It checks that the answer has two bytes, but not that
the value is above zero, and goes on with `if (start % pagesize) …` and `if (end % pagesize) …`: with an answer of
`00 00` that is an integer division by zero, and hs485d dies with SIGFPE in the middle of the update - the RPC call
never returns, the wired service is gone, and the device is left in its bootloader with the bus in sleep mode (the
`Z` that would wake the other devices is never sent). `VerifyFlash()` has the same two lines.

A bootloader that answers `p` with zeros is not a healthy one, but it is a device on the bus answering a question,
and the daemon's answer to it should be a failed update, not its own end.

## How to reproduce

In the suite: `test/daemon/hs485d-firmware.test.js`, "a bootloader that answers a page size of 0: hs485d reports
false and lives (bootloader-pagesize-zero)" - the simulated HMW-LC-Sw2-DR on the simulated HMW-LGW enters its
bootloader on `u` and answers `p` with `00 00`; hs485d exits with SIGFPE right after. Runs as `todo` under the name
`bootloader-pagesize-zero`; measured on 3.89.11, main and the fork's `lite`.

## Expected

`WriteFlash()` and `VerifyFlash()` return false for a page size of 0 (and, reasonably, for one above the bootloader's
block limit or not a power of two); `UpdateFirmware()` then sends `g`, wakes the bus and returns false.

## Cause (public source)

[HS485Device.cpp:734-741 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/HS485Device.cpp#L734-L741)
in `WriteFlash` ([:724](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/HS485Device.cpp#L724)),
the same in `VerifyFlash` ([:784-791](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/HS485Device.cpp#L784-L791));
called from `UpdateFirmware` ([:822](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/HS485Device.cpp#L822))
in the RPC thread. Unchanged on main ([HS485Device.cpp:734-741](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/hs485d/HS485Device.cpp#L734-L741)).

## Proposed fix

After `pagesize` is assembled, in both functions: `if (pagesize == 0) { LOG(Logger::LOG_ERROR, "Invalid page size 0 from %s", GetSerial().c_str()); return false; }`.
