#!/bin/bash
#
# Builds the report site of a CI run (scripts/report.mjs) on top of the published one: fetches the published history,
# the previous main sweep and the proof from GitHub Pages, judges this run's proof runs (or keeps the published proof)
# and writes the site with this run added to the history.
#
# The CI runs it twice: in the report job (the summary and the test-report artifact, every branch) and in the deploy
# job, which builds and publishes in one job of the `pages` concurrency group - so two overlapping runs publish one
# after another, and the later one starts from the history the earlier one published (B-2: before, both fetched the
# history at their start and the one published last dropped the other's entry).
#
# Usage: scripts/build-site.sh <artifacts dir> <proofs dir> <out dir> [<trigger>]
#   env: GITHUB_SHA, GITHUB_REF_NAME, GITHUB_RUN_ID, GITHUB_SERVER_URL, GITHUB_REPOSITORY (as in GitHub Actions);
#        SITE (default https://hobbyquaker.github.io/hm-radio-simulator); SUMMARY, a file the proof's and the
#        report's Markdown summaries are appended to (default none)
#
set -euo pipefail

ARTIFACTS=${1:?usage: $0 <artifacts dir> <proofs dir> <out dir> [<trigger>]}
PROOFS=${2:?missing proofs dir}
OUT=${3:?missing out dir}
TRIGGER=${4:-}
SITE=${SITE:-https://hobbyquaker.github.io/hm-radio-simulator}
SUMMARY=${SUMMARY:-}
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf -- "${WORK}"' EXIT
previous=${WORK}/previous

mkdir -p "${previous}/sweep"
# the main sweep records of the previous run, for the differential against the previously tested commit
curl -fsSL "${SITE}/sweep/main.json" -o "${previous}/sweep/main.json" || rm -f "${previous}/sweep/main.json"
# the proof of the regression tests, kept when this run does not prove
curl -fsSL "${SITE}/proof.json" -o "${previous}/proof.json" || rm -f "${previous}/proof.json"
if curl -fsSL "${SITE}/history.json" -o "${previous}/history.json"; then
  for id in $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).map((e) => e.id).join(" "))' "${previous}/history.json"); do
    mkdir -p "${previous}/runs/${id}"
    curl -fsSL "${SITE}/runs/${id}/index.html" -o "${previous}/runs/${id}/index.html" || true
    curl -fsSL "${SITE}/runs/${id}/report.json" -o "${previous}/runs/${id}/report.json" || true
  done
else
  echo "no published history yet"
fi

mkdir -p "${PROOFS}"
node "${HERE}/scripts/prove.mjs" collect "${PROOFS}" --previous "${previous}/proof.json" --out "${WORK}/proof.json" >"${WORK}/proof.txt" || true
if [ -n "${SUMMARY}" ] && [ -s "${WORK}/proof.txt" ]; then
  { echo '### Proof of the regression tests'; echo '```'; cat "${WORK}/proof.txt"; echo '```'; } >>"${SUMMARY}"
fi

node "${HERE}/scripts/report.mjs" collect --out "${OUT}" --previous "${previous}" --keep 20 --proof "${WORK}/proof.json" \
  --repo-sha "${GITHUB_SHA:-}" --ref "${GITHUB_REF_NAME:-}" --run-id "${GITHUB_RUN_ID:-}" \
  --run-url "${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}" \
  --trigger "${TRIGGER}" "${ARTIFACTS}"
if [ -n "${SUMMARY}" ]; then
  cat "${OUT}/summary.md" >>"${SUMMARY}"
fi
