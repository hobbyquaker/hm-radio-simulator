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
#   FUZZ_SECONDS  time budget per harness (default 60)
#   FUZZ_EXPECT_FINDINGS  "1": findings are expected for this ref (an old tag); exit 0 and say so
#
set -uo pipefail

FUZZ_BIN=${FUZZ_BIN:-/opt/fuzz/bin}
FUZZ_SEEDS=${FUZZ_SEEDS:-/opt/fuzz/seeds}
FUZZ_CORPUS=${FUZZ_CORPUS:-/results/corpus}
FUZZ_ARTIFACTS=${FUZZ_ARTIFACTS:-/results/artifacts}
FUZZ_SECONDS=${FUZZ_SECONDS:-60}
FUZZ_EXPECT_FINDINGS=${FUZZ_EXPECT_FINDINGS:-0}
export ASAN_OPTIONS=${ASAN_OPTIONS:-detect_leaks=0}
export UBSAN_OPTIONS=${UBSAN_OPTIONS:-print_stacktrace=1}

if [ -d /results ]; then
  trap 'chmod -R a+rwX /results 2>/dev/null || true' EXIT
fi

findings=0
summary=()
for harness in fuzz_xmlrpc_value fuzz_xmlrpc_request fuzz_xmlparser; do
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
    "$FUZZ_CORPUS/$harness" $seeds 2>&1 | tail -n 60
  status=${PIPESTATUS[0]}
  if [ "$status" -ne 0 ]; then
    findings=$((findings + 1))
    summary+=("$harness: FINDING (exit $status), artifacts in $FUZZ_ARTIFACTS/$harness")
  else
    summary+=("$harness: clean after $FUZZ_SECONDS s")
  fi
done

echo
echo "=== fuzz summary"
printf '%s\n' "${summary[@]}"
if [ "$findings" -gt 0 ]; then
  if [ "$FUZZ_EXPECT_FINDINGS" = "1" ]; then
    echo "findings were expected for this OpenCCU-Base ref (FUZZ_EXPECT_FINDINGS=1); not failing"
    exit 0
  fi
  exit 1
fi
