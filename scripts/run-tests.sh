#!/bin/bash
#
# Builds the test image for an OpenCCU-Base ref and runs the daemon suite in it, release and ASan, plus a short fuzz
# run. Results land in ./results/<variant>/ and ./results/fuzz/, the report in ./results/site/ (index.html, summary.md).
#
# Usage: scripts/run-tests.sh [options]
#   --ref <ref>          OpenCCU-Base branch, tag or commit (default 3.89.11)
#   --variants <list>    comma-separated: release, asan, coverage (default release,asan,coverage)
#   --known-broken <l>   OpenCCU-Base issues known unfixed in the ref (default per ref, see below)
#   --fuzz <seconds>     also run the fuzz harnesses for that long each (default 0 = skip)
#   --no-build           reuse the images
#
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
REF=3.89.11
VARIANTS=release,asan,coverage
KNOWN=
FUZZ=0
BUILD=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) REF=$2; shift 2 ;;
    --variants) VARIANTS=$2; shift 2 ;;
    --known-broken) KNOWN=$2; shift 2 ;;
    --fuzz) FUZZ=$2; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
if [ -z "${KNOWN}" ]; then
  case "${REF}" in
    3.89.11) KNOWN=115,116,138,140,double-join,read-eof,aes-republish,wired-maintenance ;;
    *) KNOWN=double-join,read-eof,aes-republish,wired-maintenance ;;
  esac
fi

tag="hm-radio-simulator:${REF//\//-}"
mkdir -p "${HERE}/results"
log="${HERE}/results/run-$(date +%Y%m%dT%H%M%S).log"
echo "ref ${REF}, variants ${VARIANTS}, known broken '${KNOWN}', fuzz ${FUZZ}s; log ${log}"

(
  flock 9
  if [ "${BUILD}" = 1 ]; then
    docker build -f "${HERE}/docker/Dockerfile" --target test \
      --build-arg "BASE_REF=${REF}" --build-arg "KNOWN_BROKEN=${KNOWN}" -t "${tag}" "${HERE}" 2>&1 | tee -a "${log}"
    test "${PIPESTATUS[0]}" -eq 0
  fi
  status=0
  IFS=, read -ra variants <<<"${VARIANTS}"
  for variant in "${variants[@]}"; do
    echo "=== daemon suite, ${variant}" | tee -a "${log}"
    rm -rf "${HERE}/results/${variant}"
    docker run --rm --init --cap-add SYS_NICE -e "HMRS_VARIANT=${variant}" -v "${HERE}/results:/results" "${tag}" npm run test:daemon 2>&1 | tee -a "${log}"
    if [ "${PIPESTATUS[0]}" -ne 0 ]; then status=1; fi
  done
  if [ "${FUZZ}" != 0 ]; then
    if [ "${BUILD}" = 1 ]; then
      docker build -f "${HERE}/docker/Dockerfile" --target fuzz --build-arg "BASE_REF=${REF}" -t "${tag}-fuzz" "${HERE}" 2>&1 | tee -a "${log}"
      test "${PIPESTATUS[0]}" -eq 0
    fi
    echo "=== fuzz, ${FUZZ}s per harness" | tee -a "${log}"
    expect=0
    [ -n "${KNOWN}" ] && expect=1
    docker run --rm -e "FUZZ_SECONDS=${FUZZ}" -e "FUZZ_EXPECT_FINDINGS=${expect}" -v "${HERE}/results/fuzz:/results" "${tag}-fuzz" 2>&1 | tee -a "${log}"
    if [ "${PIPESTATUS[0]}" -ne 0 ]; then status=1; fi
  fi
  echo "=== report" | tee -a "${log}"
  node "${HERE}/scripts/report.mjs" collect --out "${HERE}/results/site" --repo-sha "$(git -C "${HERE}" rev-parse HEAD 2>/dev/null || true)" \
    --ref "$(git -C "${HERE}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)" "${HERE}/results" 2>&1 | tee -a "${log}" || true
  echo "=== done, status ${status}" | tee -a "${log}"
  exit "${status}"
) 9>"${HERE}/.docker.lock"
