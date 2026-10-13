---
status: draft
component: rfd
refs: [3.89.11 (3ed652a), main (030dba7), lite (632cf5d)]
suite: info-blank-line
---

# rfd terminates on a blank line in a user firmware `info` file (RFFirmwareManager::TrimLine)

## What happens

rfd reads user-deployed device firmware from `User Firmware Dir/<dir>/info` (`TypeCode=`, `FirmwareVersion=`) at
start-up and on `refreshDeployedDeviceFirmwareList`. `RFFirmwareManager::TrimLine()` trims every line of such a file
with `for (unsigned int i = line.size() - 1; i >= 0; i--) { if (isspace(line.at(i))) … }`. For an empty line
`line.size() - 1` is `UINT_MAX`, `line.at(UINT_MAX)` throws `std::out_of_range`; for a line of blanks only, the loop
runs past index 0 and wraps to the same. Nothing catches the exception - libXmlRpc's request loop catches
`XmlRpcException` only - so rfd terminates:

    terminate called after throwing an instance of 'std::out_of_range'
      what():  basic_string::at: __n (which is 4294967295) >= this->size() (which is 0)

At start-up this means rfd never comes up (SIGABRT before the RPC port is open) as long as the file is there; a
line such as `=1.0` (an empty key) does the same through `TrimLine(key)`.

An `info` file is written by whoever deploys a firmware; a blank line between the two keys, or a trailing one in an
editor, is an ordinary thing to have in it.

## How to reproduce

In the suite: `test/daemon/rfd-firmware.test.js`, "a user firmware info file with a blank line: rfd starts and reads
the rest (info-blank-line)" - `User Firmware Dir/blank/info` holds `TypeCode=257`, an empty line and
`FirmwareVersion=2.13`, next to an `.eq3`; rfd is started with the directory in place and dies with SIGABRT during
`RFManager::Init`. Runs as `todo` under the name `info-blank-line`; measured on 3.89.11, main and the fork's `lite`.

## Expected

Blank lines are skipped (`ParseInfoFile` already means to: it tests `line.empty()` right after the trim) and the
firmware is registered.

## Cause (public source)

[RFFirmwareManager.cpp:289 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/RFFirmwareManager.cpp#L289)
in `TrimLine` ([:277](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/RFFirmwareManager.cpp#L277)),
called from `ParseInfoFile` for every line, key and value
([:235](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/RFFirmwareManager.cpp#L235),
[:249](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/RFFirmwareManager.cpp#L249),
[:252](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/RFFirmwareManager.cpp#L252));
`ParseInfoFile` runs from `SetFirmwarePaths` in `RFManager::Init`
([RFManager.cpp:205](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/RFManager.cpp#L205))
and from the RPC method ([:1571](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/RFManager.cpp#L1571)),
whose only handler is for `XmlRpcException`
([XmlRpcServerConnection.cpp:246](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libXmlRpc/src/XmlRpcServerConnection.cpp#L246)).
Unchanged on main ([RFFirmwareManager.cpp:289](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/RFFirmwareManager.cpp#L289)).

## Proposed fix

`TrimLine` with the string's own tools: `line.erase(0, line.find_first_not_of(" \t\r\n"))` and
`line.erase(line.find_last_not_of(" \t\r\n") + 1)`, guarded for `npos` (an all-blank line becomes empty). Or the
loop as `for (size_t i = line.size(); i > 0; i--)` on `line[i - 1]`.
