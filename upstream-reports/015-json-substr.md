---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/175, fixed upstream: d64c76f2feb4d92a38b733a97d565d2589ce57a6 (#260)
component: rfd
refs: [3.89.9 (5b47e37), 3.89.11 (3ed652a), main (570566e)]
suite: json-substr
relevance: rare # rare: rare: needs an HM-LC-RGBW-WM and a script or client that sends malformed JSON - then rfd aborts, on every repetition
---

# rfd terminates on setValue with a malformed JSON value for a parameter with write dependencies

## What happens

A parameter with write dependencies (`has_write_dependencies="true"` in the device description - HM-LC-RGBW-WM's
`USER_COLOR` and `USER_PROGRAM` in `rf_rgbw.xml`) takes its value as a JSON string, which
`RFChannel::setValueWithWriteDependencies()` hands to `JSONObject`. For a member without a value, e.g.
`{"ACT_HSV_COLOR_VALUE":}`, `JSONObject::parseBlock()` throws `std::out_of_range` (`basic_string::substr`).
Nothing between it and the RPC server catches it - `XmlRpcServerConnection` catches only `XmlRpcException` - so
the exception ends the process: `terminate called after throwing an instance of 'std::out_of_range'`, SIGABRT.

One RPC call from any client that can reach rfd's port stops the BidCoS service, provided an HM-LC-RGBW-WM is paired.
It is not even an exotic input: a value a script assembles with an empty variable looks exactly like that.

## How to reproduce

In the suite: `test/daemon/parsers.test.js`, "a malformed JSON value for USER_COLOR (HM-LC-RGBW-WM, a parameter with
write dependencies) is refused, rfd lives" - a simulated HM-LC-RGBW-WM is paired, then
`setValue("<serial>:2", "USER_COLOR", "{\"ACT_HSV_COLOR_VALUE\":}")`. Runs as `todo` under the name
`json-substr`. The libFuzzer harness `fuzz/fuzz_json.cpp` finds it within seconds. Measured on 3.89.11 (release): rfd ends
with SIGABRT on the call, the call itself gets no answer.

## Expected

A fault for the malformed value (e.g. -5 "Value not supported"), rfd keeps running.

## Cause (public source)

`JSONObject::parseBlock()` removes the key, then looks for the empty value in what is left: `s.find("")` is 0,
`keyvalueEnd` becomes 1, and `keyvalueEnd < s.length()-1` compares against `(size_t)0 - 1` for the now empty
string, so `s.substr(1)` runs on an empty string
([JSONObject.cpp:145-150 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/JSONObject.cpp#L145-L150)). The value comes straight from setValue
([RFChannel.cpp:175](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/RFChannel.cpp#L175)), and the connection catches only `XmlRpcException`
([XmlRpcServerConnection.cpp:246](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libXmlRpc/src/XmlRpcServerConnection.cpp#L246)). Unchanged on main
([JSONObject.cpp:145-150](https://github.com/OpenCCU/OpenCCU-Base/blob/570566e3fa0979698b83d0b6714997f78e8f9979/src/rfd/JSONObject.cpp#L145-L150)).

## Proposed fix

In `parseBlock()`: `if (!s.empty() && keyvalueEnd + 1 < s.length())` (no unsigned underflow), and check every
`substr` position against the length. In `setValueWithWriteDependencies()`: throw `XmlRpcException("Invalid JSON
value", -5)` when `!jsonObj.isValid()` (there is a TODO for exactly that). And catch `std::exception` in the RPC
dispatch, turning it into a fault, so one bad parser cannot end the daemon.
