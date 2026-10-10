#!/bin/bash
#
# Builds the libFuzzer harnesses from the OpenCCU-Base sources with clang's fuzzer, address and undefined-behaviour
# sanitizers. The library sources are compiled straight into each harness.
#
# Usage: build.sh <openccu-base dir> <output dir>
#
set -euo pipefail

SRC=${1:?usage: $0 <openccu-base dir> <output dir>}
OUT=${2:?missing output dir}
HERE=$(cd "$(dirname "$0")" && pwd)
CXX=${CXX:-clang++}

FLAGS=(
  -std=c++11 -g -O1
  -fsanitize=fuzzer,address,undefined
  -fno-omit-frame-pointer
  -D_TIME_BITS=64 -D_FILE_OFFSET_BITS=64
  -Wno-deprecated-declarations
)

XMLRPC="$SRC/src/libXmlRpc/src"
XMLPARSER="$SRC/src/libxmlparser"
mkdir -p "$OUT"

echo "building fuzz_xmlrpc_value"
"$CXX" "${FLAGS[@]}" -I"$XMLRPC" "$HERE/fuzz_xmlrpc_value.cpp" "$XMLRPC"/*.cpp -o "$OUT/fuzz_xmlrpc_value"
echo "building fuzz_xmlrpc_request"
"$CXX" "${FLAGS[@]}" -I"$XMLRPC" "$HERE/fuzz_xmlrpc_request.cpp" "$XMLRPC"/*.cpp -o "$OUT/fuzz_xmlrpc_request"
echo "building fuzz_xmlparser"
"$CXX" "${FLAGS[@]}" -I"$XMLPARSER" "$HERE/fuzz_xmlparser.cpp" "$XMLPARSER/xmlParser.cpp" -o "$OUT/fuzz_xmlparser"
echo "fuzz harnesses in $OUT"
