---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/168, fixed upstream: 9ed78fe45bb16281d4bec46603f06ffa1f7134b2 (#268)
component: libhsscomm (rfd, hs485d)
refs: [3.89.11 (3ed652a), main (030dba7)]
suite: string-uint-conversion
relevance: edge # rare edge case: certain for HM-OU-LED16 owners (an uncommon device), but a release build misreads only if the dead stack slot was reused
---

# libhsscomm: type_conversion_string_unsigned_integer reads a destroyed temporary string

## What happens

`HSSTypeConversionStringUnsignedInteger::LogicalToPhysical()` keeps a pointer into a temporary:

```cpp
const char* strValue = ((std::string) in).c_str();
```

The temporary `std::string` is destroyed at the end of that statement, and the loop below walks `strValue` after it.
Under AddressSanitizer rfd aborts with a stack-use-after-scope (HSSTypeConversionStringUnsignedInteger.cpp:58) as
soon as a device whose description uses this conversion gets its channels: the HM-OU-LED16
(`rf_ou_led16_le_v1_0.xml`), at channel set-up (`RFDevice::CreateChannels()` → `HSSParamset::SetupInstance()` →
`RFPhysicalDataInterfaceCommand::SetupInstance()` → `HSSParameter::LogicalToPhysical()`), i.e. on learning in and on
every start with such a device. The release build reads the dead stack slot and gets a value that is right as long as
nothing reused the slot in between - a silent wrong conversion otherwise.

## How to reproduce

In the suite: `test/daemon/rfd-sweep.test.js` - the device-type sweep found it (one virtual instance of every
rftypes type, under ASan); the test "the HM-OU-LED16 ... (the string-uint-conversion finding)" pins it and runs as
`todo` under the name `string-uint-conversion`. By hand: `addVirtualDeviceInstance` with the announcement of an
HM-OU-LED16 against an ASan build of rfd.

## Expected

The conversion keeps the string alive while it reads it.

## Cause (public source)

[HSSTypeConversionStringUnsignedInteger.cpp:53 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libhsscomm/HSSTypeConversionStringUnsignedInteger.cpp#L53);
unchanged on main ([:53](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/libhsscomm/HSSTypeConversionStringUnsignedInteger.cpp#L53)).

## Proposed fix

```cpp
const std::string str = in;
const char* strValue = str.c_str();
```
