---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/173, fixed upstream: 592e903b0f8546f85486ef629b18819e2d09a9b2 (#274)
component: rfd
refs: [3.89.11 (3ed652a), main (030dba7)]
suite: flush-drops-events
---

# rfd discards unread events from the radio module before every command it sends

## What happens

`CCU2SerialPortWrapperLinux::SendData()` calls `tcflush(fd, TCIFLUSH)` before it writes a command to the module.
TCIFLUSH throws away everything the kernel has received on the serial line and rfd's receive thread has not read yet.
If the module has just reported an event - a key press, a status report, a duty-cycle event - and the receive thread
is a moment late, that frame is gone: the logic layer never sees the press.

The window is small on an idle system, but rfd writes a command for every `setValue`, every config read and write,
every keep-alive of the interface; the busier rfd and the slower the host, the more events fall into it. Measured with
the suite's load test (3.89.11, ASan build, i.e. a slower rfd): during a burst of 50 `setValue` calls at 8 per second,
one of 19 remote presses never reached the receiver; the release build happened to lose none in that run.

## How to reproduce

In the suite: `test/daemon/rfd-load.test.js`, the subtests "every press reached the receiver" of the burst and the
overload - a simulated remote presses every 300 ms while rfd sends. Run as `todo` under the name
`flush-drops-events`.

## Expected

No input is discarded: the protocol is framed and the receive thread can sort responses from events (it does already),
so the flush is not needed; if stale bytes after a reset are the concern, flush once when the port is opened.

## Cause (public source)

[CCU2SerialPortWrapperLinux.cpp:47 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/hm2/CCU2SerialPortWrapperLinux.cpp#L47) (and the Win32
twin); unchanged on main.

## Proposed fix

Drop the `tcflush(fd, TCIFLUSH)` from `SendData()`.
