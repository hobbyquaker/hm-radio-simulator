// libFuzzer harness for libXmlRpc's value deserializers: the BIN-RPC stream decoder (OpenCCU-Base #140 lives here)
// and the XML value parser. Built from the OpenCCU-Base sources at image-build time (see build.sh); nothing of the
// library is vendored.
#include <cstddef>
#include <cstdint>
#include <string>

#include "XmlRpcValue.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    std::string input(reinterpret_cast<const char*>(data), size);
    {
        int offset = 0;
        XmlRpc::XmlRpcValue value;
        try {
            value.fromStream(input, &offset);
        } catch (...) {
        }
    }
    {
        int offset = 0;
        XmlRpc::XmlRpcValue value;
        try {
            value.fromXml(input, &offset);
        } catch (...) {
        }
    }
    return 0;
}
