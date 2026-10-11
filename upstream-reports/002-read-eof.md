---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/162
component: rfd (CCU2SerialPortWrapperLinux, CCU2CommController)
refs: [3.89.11 (3ed652a), main (030dba7)]
suite: read-eof
---

# End of file on the serial device: rfd spins at 100 % CPU and keeps reporting the interface as `CONNECTED`

## What happens

When the serial device behind an `[Interface] Type = CCU2` returns end of file - `read()` gives 0 - rfd's receive
thread loops without a pause and uses a full core, and `listBidcosInterfaces` keeps `CONNECTED = true`. On 3.89.11 this
is the general behaviour of a lost module; on main, #115 and #116 handle the error case (`read()` returning -1 with
`ENODEV` from a stale `/dev/mmd_bidcos`, `EIO` from an unplugged adapter) but not the end-of-file case.

A pseudo-terminal whose master went away answers `read()` with 0, which is how the suite sees it; a serial driver
that delivers EOF on hangup would show the same.

## How to reproduce

The suite's test `module lost: the pty hangs up - rfd stays alive without spinning (#115) and reports CONNECTED false
(#116)` in `test/daemon/rfd-pty-module.test.js`, its subtests `no busy loop after the hangup` and `listBidcosInterfaces
reports the interface as not connected`:

```sh
scripts/run-tests.sh --ref main --variants release
docker run --rm --init --cap-add SYS_NICE -e HMRS_KNOWN_BROKEN= hm-radio-simulator:main \
  node --test --test-name-pattern 'module lost' test/daemon/rfd-pty-module.test.js
```

Measured there: 199-201 of 200 clock ticks in the two seconds after the hangup, and `CONNECTED` stays true.

## Expected

The same as for a read error: one error line, no busy loop, and after the persistent-error threshold of #116 the
interface reported as not connected.

## Cause (public source)

[`CCU2SerialPortWrapperLinux::ReadData()` on main](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/CCU2SerialPortWrapperLinux.cpp#L102-L131)
treats only `count < 0` as an error (`handleReadError("read")`); `count == 0` resets `readError` and returns 0. The
caller, [`CCU2CommController::receiveThreadFunction()`](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/hm2/CCU2CommController.cpp#L328-L366),
`continue`s on 0, and `WaitForData()` returns at once because the descriptor stays readable - a tight loop.
`IsConnected()` reflects the error state that is never set.

## Proposed fix

In `ReadData()`, treat `count == 0` as a read error (end of file: the device is gone) and route it through
`handleReadError()`, so the error counting and the `CONNECTED = false` of #115/#116 apply. A log line that says "end of
file" instead of `strerror(errno)` would keep the message honest.
