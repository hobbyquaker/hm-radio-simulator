#!/bin/bash
#
# Fetches the parts of an OpenCCU-Base revision that the daemon build and the test image need, as a shallow sparse
# checkout: the CMake build system, the complete src/ tree (the daemons, their libraries, the device descriptions;
# the web UI and Tcl sources come along because the component CMake of newer revisions adds them). The sources are HMSL-2/LGPL/GPL licensed by eQ-3 and the OpenCCU project and stay in the
# image only; nothing of them is copied into this repository.
#
# Usage: fetch-openccu-base.sh <repo-url> <ref> <destdir>
#
set -euo pipefail

REPO=${1:?usage: $0 <repo-url> <ref> <destdir>}
REF=${2:?missing ref}
DEST=${3:?missing destdir}

if [[ -e ${DEST} ]]; then
  echo "ERROR: ${DEST} already exists" >&2
  exit 1
fi

git init -q "${DEST}"
git -C "${DEST}" remote add origin "${REPO}"
# the whole src/ tree: OpenCCU-Base's component CMake (main) adds every component directory, so leaving the web UI
# or the Tcl modules out breaks the configure even though only rfd and hs485d are built
git -C "${DEST}" sparse-checkout set --no-cone \
  '/CMakeLists.txt' '/CMakePresets.json' '/cmake/' '/licenses/' '/src/'
git -C "${DEST}" fetch -q --depth 1 --filter=blob:none origin "${REF}"
git -C "${DEST}" -c advice.detachedHead=false checkout -q FETCH_HEAD

commit=$(git -C "${DEST}" rev-parse HEAD)
echo "${commit}" >"${DEST}/.openccu-base-commit"
echo "${REF}" >"${DEST}/.openccu-base-ref"
rm -rf "${DEST:?}/.git"

for f in CMakeLists.txt src/rfd/CMakeLists.txt src/hs485d/CMakeLists.txt src/libXmlRpc/CMakeLists.txt \
         src/libxmlparser/CMakeLists.txt src/devicetypes/rftypes src/devicetypes/hs485types; do
  if [[ ! -e ${DEST}/${f} ]]; then
    echo "ERROR: ${f} missing in OpenCCU-Base ${REF} (${commit})" >&2
    exit 1
  fi
done

echo "fetched OpenCCU-Base ${REF} (${commit}) to ${DEST} ($(du -sh "${DEST}" | cut -f1))"
