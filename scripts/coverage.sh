#!/bin/bash
#
# Turns the .profraw files the coverage-variant daemons kept during a suite run (continuous mode: one mmapped file
# per process and instrumented object, complete even after a SIGTERM) into what the report publishes:
#
#   coverage.info     an lcov tracefile (file paths and hit counts, no source text) over rfd, hs485d and the
#                     libraries they load - anyone with the OpenCCU-Base source at that commit can render it
#                     (genhtml coverage.info, with the /openccu-base prefix mapped to the checkout)
#   coverage.json     llvm-cov's export (summary only, per file), the same without source text
#   coverage-summary.json  per daemon and library: lines, functions, branches (scripts/coverage-summary.mjs)
#
# Usage: coverage.sh <profiles dir> <daemons dir> <output dir>
#
set -euo pipefail

PROFILES=${1:?usage: $0 <profiles dir> <daemons dir> <output dir>}
DAEMONS=${2:?missing daemons dir}
OUT=${3:?missing output dir}
HERE=$(cd "$(dirname "$0")/.." && pwd)

mkdir -p "${OUT}"
shopt -s nullglob
raws=("${PROFILES}"/*.profraw)
if [ "${#raws[@]}" -eq 0 ]; then
  echo "coverage.sh: no .profraw files in ${PROFILES} (did the daemons run with LLVM_PROFILE_FILE set?)" >&2
  exit 1
fi
echo "coverage.sh: merging ${#raws[@]} profiles"
llvm-profdata merge -sparse "${raws[@]}" -o "${OUT}/merged.profdata"

objects=("${DAEMONS}/bin/rfd" -object "${DAEMONS}/bin/hs485d")
for lib in "${DAEMONS}"/lib/*.so; do
  objects+=(-object "${lib}")
done
llvm-cov export -format=lcov -instr-profile "${OUT}/merged.profdata" "${objects[@]}" >"${OUT}/coverage.info"
llvm-cov export -format=text -summary-only -instr-profile "${OUT}/merged.profdata" "${objects[@]}" >"${OUT}/coverage.json"
node "${HERE}/scripts/coverage-summary.mjs" "${OUT}/coverage.info" >"${OUT}/coverage-summary.json"
rm -f "${OUT}/merged.profdata"
echo "coverage.sh: wrote ${OUT}/coverage.info, coverage.json, coverage-summary.json"
