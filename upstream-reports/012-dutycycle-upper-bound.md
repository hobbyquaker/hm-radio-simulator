---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/172
component: rfd
refs: [3.89.11 (3ed652a), main (030dba7)]
suite: dutycycle-upper-bound
relevance: edge # rare edge case: 100 % duty cycle does occur, but a release build discards the value read past the end; only ASan aborts
---

# rfd reads past its duty-cycle threshold map when the module reports 100 %

## What happens

`BidcosInterface::SetDutyCycle()` sorts the duty cycle the module reports into thresholds
(`DUTYCYCLE_THRESHOLDMAP`: 0, 40, 65, 80, 90, 95, 98, 99, 100 - nine entries) and raises a `DUTY_CYCLE` event when
the threshold changes. `GetDutyCycleUpperBound()` returns the entry above the current one:

```cpp
if (duty_cycle_threshold <= DUTYCYCLE_THRESHOLDMAP_SIZE)
    return DUTYCYCLE_THRESHOLDMAP[duty_cycle_threshold + 1];
```

When the module reports 100 %, `UpdateDutyCycleThreshold()` moves the threshold to the last entry (index 8) and
asks for the bound once more: index 9 is read, one past the array. Under AddressSanitizer rfd aborts with a
global-buffer-overflow (BidcosInterface.cpp:286, from the receive thread's `handleIncomingEvent`); the release
build reads whatever global follows the array. The condition also lets index `SIZE + 1` through.

A module reports 100 % whenever the central has used its 1 % of airtime - a scene with many actuators, a firmware
update, a stuck automation - so this runs on real systems.

## How to reproduce

In the suite: `test/daemon/rfd-load.test.js`, "rfd takes a reported duty cycle of 100 % without reading past its
threshold map" - the simulated module reports 50, 90, 99, 100 %. Runs as `todo` under the name
`dutycycle-upper-bound`. The load test's overload found it (the module's duty cycle driven to 100 %).

## Expected

At the last threshold, the upper bound is the last entry (or no bound at all).

## Cause (public source)

[BidcosInterface.cpp:282-292 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/BidcosInterface.cpp#L282-L292), the map at
[:38-49](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/BidcosInterface.cpp#L38-L49); unchanged on main
([:282-292](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/BidcosInterface.cpp#L282-L292)).

## Proposed fix

`if (duty_cycle_threshold < DUTYCYCLE_THRESHOLDMAP_SIZE - 1)`.
