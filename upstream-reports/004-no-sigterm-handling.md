---
status: draft
component: rfd, hs485d
refs: [3.89.11 (3ed652a), main (030dba7)]
suite: -
---

# rfd and hs485d do not handle SIGTERM: a pending save is lost when the daemon is stopped

## What happens

Neither daemon installs a handler for SIGTERM (or SIGINT). When the init system, monit or a unit stops them - with
SIGTERM, as all of them do - the process dies by the default action: the main loop does not return, the manager is
not destructed, and whatever the daemon still meant to write is lost. Device files are saved from a timer
(`RequestSave()` → `Save()` later), so a change made shortly before the stop - a link, a sticky flag reset, a received
configuration - is gone after the restart. The module or LAN gateway is left mid-conversation (no clean close, the
HM-LGW sees a dropped TCP connection).

## How to reproduce

Make a change that is persisted lazily and stop the daemon within the save delay, then start it again on the same
directory:

```sh
# the suite's rfd, a paired device present
binrpc call setLinkInfo ...    # or any change that marks a device file dirty
kill -TERM <pid of rfd>
# start rfd again: the change is not in the device file
```

(The suite will carry this as a test under its "restart, device files and config" item.) The coverage build of the
suite shows it from another side: a coverage-instrumented daemon writes its profile at exit, and none is written when
the daemon is stopped with SIGTERM.

## Expected

SIGTERM ends the main loop (`run = false`), the manager is destructed and saves, the module or gateway is closed, the
process exits with 0.

## Cause (public source)

rfd installs no signal handler besides ignoring SIGCHLD:
[rfd.cpp:194 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/rfd.cpp#L194).
hs485d has a handler that sets `run = false`, but both its definition and its registration are commented out:
[hs485d.cpp:80-87](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/hs485d.cpp#L80-L87)
and [hs485d.cpp:148-149](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/hs485d/hs485d.cpp#L148-L149).
The same on main ([rfd.cpp](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/rfd.cpp#L194),
[hs485d.cpp](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/hs485d/hs485d.cpp#L148-L149)).

## Proposed fix

Install a SIGTERM (and SIGINT) handler in both daemons that sets `run = false`, so the existing shutdown path runs:
in hs485d by uncommenting the handler and its two `signal()` calls, in rfd by adding the same three lines. The RPC
method `exit` (see 003) does exactly this today, which shows the shutdown path itself works.
