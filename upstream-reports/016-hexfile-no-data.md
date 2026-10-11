---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/176
component: libelvutils, hs485d
refs: [3.89.9 (5b47e37), 3.89.11 (3ed652a), main (570566e)]
suite: hexfile-no-data
---

# Hexfile::Read erases from begin() to begin() - 1 for a hex file without a data record

## What happens

`Hexfile::Read()` starts with `start = -1` and sets it only when a data record (type 00) ends. A file whose end
record (type 01) comes before any data record - an empty or truncated firmware file, `:00000001FF` alone - reaches
`buffer.erase(buffer.begin(), buffer.begin() + start)` with `start == -1`: an iterator before the vector's
start. hs485d reads the wired firmware files listed in `fwmap` to report `AVAILABLE_FIRMWARE`, the first time a
device of that type is described (a search, `getDeviceDescription`, `listDevices`), so such a file makes hs485d
crash with SIGSEGV during `searchDevices` (measured on 3.89.11, release) - and again whenever a device of that
type is described after a restart.

The files are local (`Firmware Dir`), so this is no remote attack; but a firmware file cut short by a full disk or an
interrupted update, or an empty file in the directory, is enough to take the wired service down for good.

## How to reproduce

In the suite: `test/daemon/parsers.test.js`, "a wired firmware file without a data record: hs485d reports no firmware
and lives" - `fwmap` names `hmrs_empty.hex` for the HMW-LC-Sw2-DR (`H17V0`), the file is `:00000001FF`, a
search finds the device. Runs as `todo` under the name `hexfile-no-data`. The libFuzzer harness `fuzz_hexfile`
(`fuzz/fuzz_file_formats.cpp`) finds it in its first executions (UBSan: "applying non-zero offset 18446744073709551615
to null pointer", then SEGV in `std::vector::erase` from Hexfile.cpp:88).

## Expected

`Read()` returns an error for a file without data; hs485d logs "Could not read firmware file" and reports no
available firmware.

## Cause (public source)

[Hexfile.cpp:41](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libelvutils/Hexfile.cpp#L41) sets `start=-1`,
[Hexfile.cpp:86-89](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libelvutils/Hexfile.cpp#L86-L89) erases with it on the end record. The caller
([HS485FirmwareManager.cpp:53-70](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/HS485FirmwareManager.cpp#L53-L70)) then also computes
`ff.version - hf->GetStart()` unsigned. Unchanged on main ([Hexfile.cpp:86-89](https://github.com/OpenCCU/OpenCCU-Base/blob/570566e3fa0979698b83d0b6714997f78e8f9979/src/libelvutils/Hexfile.cpp#L86-L89)).

## Proposed fix

On the end record: `if (start < 0) { fclose(f); return -1; }` before the erase (and `start <= buffer.size()`).
