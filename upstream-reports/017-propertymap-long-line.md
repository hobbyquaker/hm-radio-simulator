---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/177
component: libelvutils, rfd, hs485d
refs: [3.89.9 (5b47e37), 3.89.11 (3ed652a), main (570566e)]
suite: propertymap-long-line
relevance: edge # rare edge case: practically never: the generated configuration lines are short; only a hand-written line of 256+ characters
---

# PropertyMap::ReadFromFile loops for ever on a line longer than 255 characters

## What happens

`PropertyMap::ReadFromFile()` - the reader of `rfd.conf`, `hs485d.conf`, the key file, the address file and the
replace map - reads with `while (!is.eof()) { is.getline(line, 256); ... }`. A line of 256 characters or more makes
`getline` set the stream's failbit without reaching the end of the file; every further `getline` fails at once,
`eof()` never becomes true, and the loop spins for ever. The daemon never gets past reading its configuration: no
RPC port, no radio, 100 % of a core.

A long comment, a long `Encryption Key` or path, or a generated configuration with a long value is enough. On
openccu-lite and OpenCCU these files are written by tools, which makes it likely to hit sooner or later, and the
symptom (a daemon that hangs at start with no log line) is hard to trace.

## How to reproduce

In the suite: `test/daemon/parsers.test.js`, "a configuration line longer than 255 characters: rfd starts" - a
322-character comment line in `rfd.conf`; rfd is still running and not answering after 20 s. Runs as `todo` under
the name `propertymap-long-line`. The libFuzzer harness `fuzz_propertymap` (`fuzz/fuzz_file_formats.cpp`) finds it
as a timeout.

## Expected

The long line is read whole (or skipped with a log line), the rest of the file is read, the daemon starts.

## Cause (public source)

[PropertyMap.cpp:70-71 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libelvutils/PropertyMap.cpp#L70-L71). Unchanged on main
([PropertyMap.cpp:70-71](https://github.com/OpenCCU/OpenCCU-Base/blob/570566e3fa0979698b83d0b6714997f78e8f9979/src/libelvutils/PropertyMap.cpp#L70-L71)).

## Proposed fix

Read with `std::string line; while (std::getline(is, line)) { ... }` (no length limit, and the loop ends on any
failure), working on `line.c_str()` copies where the code needs a writable buffer.
