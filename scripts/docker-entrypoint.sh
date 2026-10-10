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
  node --test --test-concurrency=1 \
    --test-reporter=spec --test-reporter-destination=stdout \
    --test-reporter=junit --test-reporter-destination="/results/${variant}/junit.xml" \
    'test/daemon/*.test.js'
  exit $?
fi
"$@"
