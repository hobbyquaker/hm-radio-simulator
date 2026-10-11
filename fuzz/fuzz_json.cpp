// libFuzzer harness for rfd's JSONObject: the value of a parameter with write dependencies (HM-LC-RGBW-WM's
// USER_COLOR and USER_PROGRAM, RFChannel::setValueWithWriteDependencies) is parsed as JSON - a string any RPC client
// passes to setValue. The parser throws std::out_of_range on input as small as {"a":} (the finding json-substr), and
// nothing between it and the RPC server catches it, so this harness finds that within seconds on every ref so far.
#include <cstddef>
#include <cstdint>
#include <string>

#include "JSONObject.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    std::string content(reinterpret_cast<const char*>(data), size);
    JSONObject json(content);
    if (json.isValid()) {
        std::string s = json.toString();
        (void)json.contains("a");
        (void)json.getString("a");
        (void)json.getInt("b");
        (void)json.getBool("c");
        (void)json.getDouble("d");
        JSONObject inner = json.getObj("e");
        (void)inner.toString();
        JSONObject again(s);
        (void)again.isValid();
    }
    return 0;
}
