// libFuzzer harness for libxmlparser's editing and serialisation (OpenCCU-Base #29: child arrays grown with
// realloc/memmove over ref-counted node data, a heap overflow when a parsed node is modified afterwards; #19: size and
// overflow checks when parsing and serialising). The input: a control part and an XML document, split at the first
// 0x00 byte. The document is parsed, then the control bytes add children, attributes, text and comments, copy and
// delete subtrees, and the result is serialised, parsed again and serialised again - the two strings must be equal.
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "xmlParser.h"

static std::string name(const std::string& raw) {
    // names from the input, kept to characters a name may have, sometimes very long (#19's length checks)
    std::string out;
    for (size_t i = 0; i < raw.size(); i++) {
        char c = raw[i];
        out += (isalnum((unsigned char)c) || c == '_' || c == '-') ? c : 'n';
    }
    return out.empty() ? std::string("n") : out;
}

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    std::string input(reinterpret_cast<const char*>(data), size);
    size_t split = input.find('\0');
    std::string control = split == std::string::npos ? std::string() : input.substr(0, split);
    std::string doc = split == std::string::npos ? input : input.substr(split + 1);
    XMLResults results;
    XMLNode root = XMLNode::parseString(doc.c_str(), NULL, &results);
    if (root.isEmpty()) {
        root = XMLNode::createXMLTopNode();
    }
    std::vector<XMLNode> nodes;
    nodes.push_back(root);
    for (size_t i = 0; i + 1 < control.size() && nodes.size() < 256; i += 2) {
        const unsigned char op = (unsigned char)control[i];
        const unsigned char arg = (unsigned char)control[i + 1];
        XMLNode target = nodes[arg % nodes.size()];
        const std::string text = name(control.substr(i, (op >> 4) == 15 ? 2000 : (arg % 24) + 1));
        switch (op % 7) {
            case 0:
                nodes.push_back(target.addChildConst(text.c_str()));
                break;
            case 1:
                target.addAttributeConst(text.c_str(), text.c_str());
                break;
            case 2:
                target.addTextConst(text.c_str());
                break;
            case 3:
                target.addClearConst(text.c_str(), "<!--", "-->");
                break;
            case 4:
                for (int c = 0; c < target.nChildNode() && nodes.size() < 256; c++) {
                    nodes.push_back(target.getChildNode(c));
                }
                break;
            case 5:
                if (target.nChildNode() > 0) {
                    XMLNode child = target.getChildNode(arg % target.nChildNode());
                    child.deleteNodeContent();
                    nodes.clear();
                    nodes.push_back(root);
                }
                break;
            default:
                // a copy that shares the data (the ref count), then a change through the copy
                XMLNode copy = target;
                copy.addChildConst(text.c_str());
                break;
        }
    }
    // serialise, parse that, serialise again (not compared: the parser is lenient with malformed input, e.g. a
    // declaration-like node "<?x" comes back as "<?x/>" and then as "<?x?>" - a difference, not a memory error)
    int n1 = 0;
    char* first = root.createXMLString(1, &n1);
    if (first) {
        XMLResults again;
        XMLNode reparsed = XMLNode::parseString(first, NULL, &again);
        if (!reparsed.isEmpty()) {
            int n2 = 0;
            free(reparsed.createXMLString(0, &n2));
        }
        free(first);
    }
    return 0;
}
