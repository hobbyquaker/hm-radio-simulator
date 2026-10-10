---
status: draft
component: rfd
refs: [3.89.11 (3ed652a), main (030dba7)]
suite: metadata-args
---

# rfd: setVolatileMetadata (and getMetadata/setMetadata) with a missing argument read freed memory

## What happens

`setVolatileMetadata` takes a pointer into its first argument and then indexes the second:

```cpp
const char* dataId = ((std::string&)params[0]).c_str();
XmlRpc::XmlRpcValue& value = params[1];
```

When the call has fewer than two arguments, `params[1]` grows the parameter array (`XmlRpcValue::assertArray()` →
`std::vector::resize()`). The vector moves its elements, the string `dataId` points into is freed, and
`MetadataStore::SetVolatile()` reads it: under AddressSanitizer rfd aborts with a heap-use-after-free in `strlen`
(from `MetadataStore::SetVolatile`, MetadataStore.cpp:144). The release build reads freed memory and usually gets
away with it - the stored key is then whatever the freed buffer holds.

`getMetadata` and `setMetadata` have the same shape inside one expression
(`MetadataGet(((std::string&)params[0]).c_str(), ((std::string&)params[1]).c_str(), ...)`): with one argument the
second index can move the first string before it is used, depending on the compiler's evaluation order.

Any RPC client on port 2001 can send such a call; a logic layer with a bug in its argument list is enough.

## How to reproduce

In the suite: `test/daemon/rfd-sweep.test.js` - the method sweep found it (the call `setVolatileMetadata()` without
arguments, under ASan); the test "metadata methods with a missing argument (the metadata-args finding)" pins it and
runs as `todo` under the name `metadata-args`. By hand, against an ASan build of rfd:

```
setVolatileMetadata("x")
```

## Expected

A fault ("Failure" or an argument error), rfd stays up and reads nothing freed.

## Cause (public source)

[XmlRpcMethods.cpp:1036-1037 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/XmlRpcMethods.cpp#L1036-L1037),
the same at [:946](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/XmlRpcMethods.cpp#L946) and [:971](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/XmlRpcMethods.cpp#L971);
unchanged on main ([XmlRpcMethods.cpp:1036-1037](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/rfd/XmlRpcMethods.cpp#L1036-L1037)).

## Proposed fix

Check `params.size()` before indexing (as `ping` and `replaceDevice` do), and copy the string instead of keeping a
pointer into the array: `std::string dataId = params[0];` before `params[1]` is touched.
