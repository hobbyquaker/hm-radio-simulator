// Fixed cases for libxmlparser's clear tags (OpenCCU-Base 97b89d98: closing clear tags matched case-insensitively,
// <PRE> and <Script> no longer clear tags). Not a fuzzer: a small test binary the fuzz job runs before the harnesses;
// it prints one line per case and exits non-zero when a case fails.
#include <cstdio>
#include <cstring>

#include "xmlParser.h"

static int failures = 0;

static void check(const char* what, bool ok) {
    printf("%s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) {
        failures++;
    }
}

int main() {
    XMLResults r;
    XMLNode a = XMLNode::parseString("<a><pre><b/></pre></a>", "a", &r);
    check("<pre> is an element: <a><pre><b/></pre></a> has a child b under pre",
          !a.isEmpty() && !a.getChildNode("pre").isEmpty() && !a.getChildNode("pre").getChildNode("b").isEmpty());
    XMLNode s = XMLNode::parseString("<a><Script><b/></Script></a>", "a", &r);
    check("<Script> is an element: its child b is parsed",
          !s.isEmpty() && !s.getChildNode("Script").isEmpty() && !s.getChildNode("Script").getChildNode("b").isEmpty());
    XMLNode c = XMLNode::parseString("<a><!-- x --><b/></a>", "a", &r);
    check("a comment closes with -->: b follows it", !c.isEmpty() && c.nClear() == 1 && !c.getChildNode("b").isEmpty());
    XMLNode d = XMLNode::parseString("<a><![CDATA[ <x/> ]]><b/></a>", "a", &r);
    check("CDATA closes with ]]>: b follows it", !d.isEmpty() && !d.getChildNode("b").isEmpty());
    printf("%d failure(s)\n", failures);
    return failures ? 1 : 0;
}
