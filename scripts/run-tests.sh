#!/bin/bash
#
# Builds the test image for an OpenCCU-Base ref and runs the daemon suite in it, release and ASan, plus a short fuzz
# run. Results land in ./results/<variant>/ and ./results/fuzz/, the report in ./results/site/ (index.html, summary.md).
#
# Usage: scripts/run-tests.sh [options]
#   --ref <ref>          OpenCCU-Base branch, tag or commit (default 3.89.11)
#   --repo <url>         the OpenCCU-Base repository to fetch it from (default OpenCCU/OpenCCU-Base; a fork to test a fix
#                        before it is upstream - the known-broken list is derived from that repository's history)
#   --variants <list>    comma-separated: release, asan, coverage (default release,asan,coverage)
#   --known-broken <l>   OpenCCU-Base issues known unfixed in the ref (default: derived, scripts/resolve-refs.mjs)
#   --fuzz <seconds>     also run the fuzz harnesses for that long each (default 0 = skip)
#   --no-build           reuse the images
#
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
REF=3.89.11
REPO=https://github.com/OpenCCU/OpenCCU-Base.git
VARIANTS=release,asan,coverage
KNOWN=
FUZZ=0
BUILD=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) REF=$2; shift 2 ;;
    --repo) REPO=$2; shift 2 ;;
    --variants) VARIANTS=$2; shift 2 ;;
    --known-broken) KNOWN=$2; shift 2 ;;
    --fuzz) FUZZ=$2; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
if [ -z "${KNOWN}" ]; then
  # derived from the fixes' merge commits and the findings (test/metadata.js), as in CI
  KNOWN=$(node "${HERE}/scripts/resolve-refs.mjs" --known "${REF}" --repo "${REPO}") || { echo "cannot derive the known-broken list for ${REF} (pass --known-broken)" >&2; exit 2; }
fi

# one lock for every checkout of this repository: the worktrees share the docker daemon and the image tags, so the lock
# lives next to the main checkout (git's common dir), not in the worktree (HMRS_DOCKER_LOCK overrides it)
common=$(git -C "${HERE}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
LOCK=${HMRS_DOCKER_LOCK:-${common:+$(dirname "${common}")/.docker.lock}}
LOCK=${LOCK:-${HERE}/.docker.lock}

tag="hm-radio-simulator:${REF//\//-}"
mkdir -p "${HERE}/results"
log="${HERE}/results/run-$(date +%Y%m%dT%H%M%S).log"
echo "ref ${REF} (${REPO}), variants ${VARIANTS}, known broken '${KNOWN}', fuzz ${FUZZ}s; log ${log}"

(
  flock 9
  if [ "${BUILD}" = 1 ]; then
    docker build -f "${HERE}/docker/Dockerfile" --target test \
      --build-arg "BASE_REPO=${REPO}" --build-arg "BASE_REF=${REF}" --build-arg "KNOWN_BROKEN=${KNOWN}" -t "${tag}" "${HERE}" 2>&1 | tee -a "${log}"
    test "${PIPESTATUS[0]}" -eq 0
  fi
  status=0
  IFS=, read -ra variants <<<"${VARIANTS}"
  for variant in "${variants[@]}"; do
    echo "=== daemon suite, ${variant}" | tee -a "${log}"
    rm -rf "${HERE}/results/${variant}"
    # not a bare pipeline: with set -e and pipefail a red variant would end the script before the next variant and the report
    if ! docker run --rm --init --cap-add SYS_NICE -e "HMRS_VARIANT=${variant}" -v "${HERE}/results:/results" "${tag}" npm run test:daemon 2>&1 | tee -a "${log}"; then status=1; fi
  done
  if [ "${FUZZ}" != 0 ]; then
    if [ "${BUILD}" = 1 ]; then
      docker build -f "${HERE}/docker/Dockerfile" --target fuzz --build-arg "BASE_REPO=${REPO}" --build-arg "BASE_REF=${REF}" -t "${tag}-fuzz" "${HERE}" 2>&1 | tee -a "${log}"
      test "${PIPESTATUS[0]}" -eq 0
    fi
    echo "=== fuzz, ${FUZZ}s per harness" | tee -a "${log}"
    expect=0
    case ",${KNOWN}," in *,140,*) expect=1 ;; esac
    harnesses=$(node "${HERE}/scripts/resolve-refs.mjs" --known "${REF}" --repo "${REPO}" --harnesses || true)
    if ! docker run --rm -e "FUZZ_SECONDS=${FUZZ}" -e "FUZZ_EXPECT_FINDINGS=${expect}" -e "FUZZ_KNOWN_HARNESSES=${harnesses}" -v "${HERE}/results/fuzz:/results" "${tag}-fuzz" 2>&1 | tee -a "${log}"; then status=1; fi
  fi
  echo "=== report" | tee -a "${log}"
  node "${HERE}/scripts/report.mjs" collect --out "${HERE}/results/site" --repo-sha "$(git -C "${HERE}" rev-parse HEAD 2>/dev/null || true)" \
    --ref "$(git -C "${HERE}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)" "${HERE}/results" 2>&1 | tee -a "${log}" || true
  echo "=== done, status ${status}" | tee -a "${log}"
  exit "${status}"
) 9>"${LOCK}"
