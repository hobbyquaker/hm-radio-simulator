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
echo "building fuzz_xmlparser_edit"
"$CXX" "${FLAGS[@]}" -I"$XMLPARSER" "$HERE/fuzz_xmlparser_edit.cpp" "$XMLPARSER/xmlParser.cpp" -o "$OUT/fuzz_xmlparser_edit"
echo "building test_xmlparser_cleartags (not a fuzzer)"
"$CXX" -std=c++11 -g -O1 -fsanitize=address,undefined -Wno-deprecated-declarations -I"$XMLPARSER" \
  "$HERE/test_xmlparser_cleartags.cpp" "$XMLPARSER/xmlParser.cpp" -o "$OUT/test_xmlparser_cleartags"

# libelvutils (Logger, PropertyMap, Hexfile, UpdateFile, ...) without the Windows files, for the harnesses below
ELV="$SRC/src/libelvutils"
ELV_SRC=()
for f in "$ELV"/*.cpp; do
  case "$f" in *Win32* | */md5.cpp) ;; *) ELV_SRC+=("$f") ;; esac
done
HM2="$SRC/src/rfd/hm2"
echo "building fuzz_ccu2_frame"
"$CXX" "${FLAGS[@]}" -I"$HM2" -I"$SRC/src/rfd" -I"$SRC/src/libhsscomm" -I"$ELV" "$HERE/fuzz_ccu2_frame.cpp" \
  "$HM2/CCU2SerialFrame.cpp" "$HM2/CCU2CoprocessorCommand.cpp" "$HM2/HM2Utils.cpp" "${ELV_SRC[@]}" -lpthread \
  -o "$OUT/fuzz_ccu2_frame"
echo "building fuzz_hmwlgw_frame"
"$CXX" "${FLAGS[@]}" -I"$SRC/src/hs485d" -I"$ELV" "$HERE/fuzz_hmwlgw_frame.cpp" \
  "$SRC/src/hs485d/HMWLGWTransportFrame.cpp" "$SRC/src/hs485d/HMWLGWCommand.cpp" "${ELV_SRC[@]}" -lpthread \
  -o "$OUT/fuzz_hmwlgw_frame"
n=0
for name in fuzz_propertymap fuzz_hexfile fuzz_updatefile; do
  echo "building $name"
  "$CXX" "${FLAGS[@]}" -DFORMAT=$n -I"$ELV" "$HERE/fuzz_file_formats.cpp" "${ELV_SRC[@]}" -lpthread -o "$OUT/$name"
  n=$((n + 1))
done
echo "building fuzz_json"
"$CXX" "${FLAGS[@]}" -I"$SRC/src/rfd" "$HERE/fuzz_json.cpp" "$SRC/src/rfd/JSONObject.cpp" -o "$OUT/fuzz_json"
echo "fuzz harnesses in $OUT"
