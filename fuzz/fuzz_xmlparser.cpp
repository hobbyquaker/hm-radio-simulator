// libFuzzer harness for libxmlparser (the XML parser rfd, hs485d and ReGaHss load device descriptions with).
#include <cstddef>
#include <cstdint>
#include <string>

#include "xmlParser.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    std::string input(reinterpret_cast<const char*>(data), size);
    XMLResults results;
    XMLNode node = XMLNode::parseString(input.c_str(), NULL, &results);
    if (!node.isEmpty()) {
        // walk what was parsed so that lazily evaluated parts are touched too
        volatile int n = node.nChildNode();
        (void)n;
        for (int i = 0; i < node.nAttribute(); i++) {
            (void)node.getAttribute(i);
        }
        for (int i = 0; i < node.nChildNode(); i++) {
            (void)node.getChildNode(i).getName();
        }
        volatile const char* text = node.getText();
        (void)text;
    }
    return 0;
}
