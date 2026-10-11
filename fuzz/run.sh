#!/bin/bash
#
# Runs every harness for a time budget, seeded from the generated seeds and the saved corpus. Crashes (ASan reports,
# timeouts, out-of-memory) end a harness with a non-zero status and leave an artifact; the script reports every
# harness and exits non-zero when any found something.
#
# Environment:
#   FUZZ_BIN      directory with the harnesses (default /opt/fuzz/bin)
#   FUZZ_SEEDS    directory with the generated seeds, one subdirectory per harness (default /opt/fuzz/seeds)
#   FUZZ_CORPUS   corpus directory, kept between runs when mounted (default /results/corpus)
#   FUZZ_ARTIFACTS where crash inputs go (default /results/artifacts)
#   FUZZ_RESULTS  where the per-harness logs and fuzz-summary.json go (default /results)
#   FUZZ_SECONDS  time budget per harness (default 60)
#   FUZZ_EXPECT_FINDINGS  "1": findings are expected for this ref (an old tag); exit 0 and say so
#   FUZZ_KNOWN_HARNESSES  harness=finding,... : harnesses with a known, unfixed finding of this suite on this ref
#                         (scripts/resolve-refs.mjs derives it); their findings are reported, not counted
#   FUZZ_HARNESSES        the harnesses to run (default: all of them)
#
set -uo pipefail

FUZZ_BIN=${FUZZ_BIN:-/opt/fuzz/bin}
FUZZ_SEEDS=${FUZZ_SEEDS:-/opt/fuzz/seeds}
FUZZ_CORPUS=${FUZZ_CORPUS:-/results/corpus}
FUZZ_ARTIFACTS=${FUZZ_ARTIFACTS:-/results/artifacts}
FUZZ_RESULTS=${FUZZ_RESULTS:-/results}
mkdir -p "$FUZZ_RESULTS"
FUZZ_SECONDS=${FUZZ_SECONDS:-60}
FUZZ_EXPECT_FINDINGS=${FUZZ_EXPECT_FINDINGS:-0}
FUZZ_KNOWN_HARNESSES=${FUZZ_KNOWN_HARNESSES:-}
export FUZZ_KNOWN_HARNESSES
FUZZ_HARNESSES=${FUZZ_HARNESSES:-fuzz_xmlrpc_value fuzz_xmlrpc_request fuzz_xmlparser fuzz_xmlparser_edit fuzz_ccu2_frame fuzz_hmwlgw_frame fuzz_propertymap fuzz_hexfile fuzz_updatefile fuzz_json}
export ASAN_OPTIONS=${ASAN_OPTIONS:-detect_leaks=0}
export UBSAN_OPTIONS=${UBSAN_OPTIONS:-print_stacktrace=1}

if [ -d /results ]; then
  trap 'chmod -R a+rwX /results 2>/dev/null || true' EXIT
fi

findings=0
summary=()
# the fixed libxmlparser cases (not a fuzzer)
if [ -x "$FUZZ_BIN/test_xmlparser_cleartags" ]; then
  echo "=== test_xmlparser_cleartags"
  if ! "$FUZZ_BIN/test_xmlparser_cleartags" | tee "$FUZZ_RESULTS/test_xmlparser_cleartags.log"; then
    findings=$((findings + 1))
    summary+=("test_xmlparser_cleartags: FAILED")
  fi
fi
for harness in $FUZZ_HARNESSES; do
  bin="$FUZZ_BIN/$harness"
  if [ ! -x "$bin" ]; then
    echo "missing harness $bin" >&2
    exit 2
  fi
  mkdir -p "$FUZZ_CORPUS/$harness" "$FUZZ_ARTIFACTS/$harness"
  seeds="$FUZZ_SEEDS/$harness"
  [ -d "$seeds" ] || seeds=""
  echo "=== $harness: $FUZZ_SECONDS s"
  "$bin" -max_total_time="$FUZZ_SECONDS" -timeout=20 -rss_limit_mb=2048 -max_len=4096 \
    -artifact_prefix="$FUZZ_ARTIFACTS/$harness/" -print_final_stats=1 \
    "$FUZZ_CORPUS/$harness" $seeds >"$FUZZ_RESULTS/$harness.log" 2>&1
  status=$?
  tail -n 60 "$FUZZ_RESULTS/$harness.log"
  echo "$status" >"$FUZZ_RESULTS/$harness.status"
  known=$(printf '%s' ",$FUZZ_KNOWN_HARNESSES," | grep -o ",$harness=[^,]*" | cut -d= -f2)
  if [ "$status" -ne 0 ] && [ -n "$known" ]; then
    summary+=("$harness: known finding $known (exit $status), artifacts in $FUZZ_ARTIFACTS/$harness")
  elif [ "$status" -ne 0 ]; then
    findings=$((findings + 1))
    summary+=("$harness: FINDING (exit $status), artifacts in $FUZZ_ARTIFACTS/$harness")
  else
    summary+=("$harness: clean after $FUZZ_SECONDS s")
  fi
done

echo
echo "=== fuzz summary"
printf '%s\n' "${summary[@]}"
# the summary for the report (scripts/report.mjs); the fuzz image carries the ref and commit it was built from
node "$(dirname "$0")/../scripts/fuzz-summary.mjs" "$FUZZ_RESULTS" "$(cat /opt/openccu-base/ref 2>/dev/null || echo unknown)" \
  "$(cat /opt/openccu-base/commit 2>/dev/null || echo unknown)" "$FUZZ_SECONDS" "$FUZZ_EXPECT_FINDINGS" \
  $FUZZ_HARNESSES || echo "fuzz-summary.json not written" >&2
if [ "$findings" -gt 0 ]; then
  if [ "$FUZZ_EXPECT_FINDINGS" = "1" ]; then
    echo "findings were expected for this OpenCCU-Base ref (FUZZ_EXPECT_FINDINGS=1); not failing"
    exit 0
  fi
  exit 1
fi
