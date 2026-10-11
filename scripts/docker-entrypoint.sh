#!/bin/bash
# Selects the daemon variant and writes a JUnit report when /results is mounted.
set -euo pipefail

variant=${HMRS_VARIANT:-release}
export HMRS_DAEMONS=/opt/daemons/${variant}
if [ ! -x "${HMRS_DAEMONS}/bin/rfd" ]; then
  echo "no daemons for variant ${variant} in ${HMRS_DAEMONS}" >&2
  exit 2
fi
echo "hm-radio-simulator: OpenCCU-Base $(cat /opt/openccu-base/ref) ($(cat /opt/openccu-base/commit)), daemons ${variant}, known broken: ${HMRS_KNOWN_BROKEN:-none}"

# the container runs as root; leave the results readable and removable for the user who mounted the directory
if [ -d /results ]; then
  trap 'chmod -R a+rwX /results 2>/dev/null || true' EXIT
fi

if [ -d /results ] && [ "$#" -gt 0 ] && [ "$1" = "npm" ]; then
  mkdir -p "/results/${variant}"
  export HMRS_WORKDIR="/results/${variant}/work"
  mkdir -p "${HMRS_WORKDIR}"
  # what the report needs to know about this job (scripts/report.mjs)
  node -e '
    const [ref, commit, variant, known, out] = process.argv.slice(1);
    require("fs").writeFileSync(out, JSON.stringify({
      ref, baseCommit: commit, variant,
      knownBroken: known.split(",").map((s) => s.trim()).filter(Boolean),
      node: process.version, startedAt: new Date().toISOString(),
    }, null, 1) + "\n");
  ' "$(cat /opt/openccu-base/ref)" "$(cat /opt/openccu-base/commit)" "${variant}" "${HMRS_KNOWN_BROKEN:-}" "/results/${variant}/meta.json"
  if [ "${variant}" = coverage ]; then
    # continuous mode (%c): every daemon process keeps its counters in mmapped profiles, one per instrumented object,
    # so a SIGTERM loses nothing (see coverage.sh)
    mkdir -p "/results/${variant}/profiles"
    export LLVM_PROFILE_FILE="/results/${variant}/profiles/%c%p-%m.profraw"
  fi
  # HMRS_TEST_NAME_PATTERN: run only the tests whose (top-level) name matches - the proof runs (scripts/prove.mjs)
  filter=()
  if [ -n "${HMRS_TEST_NAME_PATTERN:-}" ]; then
    filter=(--test-name-pattern="${HMRS_TEST_NAME_PATTERN}")
  fi
  node --test --test-concurrency=1 "${filter[@]}" \
    --test-reporter=spec --test-reporter-destination=stdout \
    --test-reporter=junit --test-reporter-destination="/results/${variant}/junit.xml" \
    --test-reporter=./scripts/json-reporter.mjs --test-reporter-destination="/results/${variant}/tests.json" \
    'test/daemon/*.test.js'
  status=$?
  if [ "${variant}" = coverage ]; then
    scripts/coverage.sh "/results/${variant}/profiles" "${HMRS_DAEMONS}" "/results/${variant}" || status=1
    rm -rf "/results/${variant}/profiles"
  fi
  exit ${status}
fi
"$@"
