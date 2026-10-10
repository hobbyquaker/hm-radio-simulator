#!/bin/bash
#
# Fetches hmlangw, the HM-LGW emulation for the HM-MOD-RPI (MIT; Oliver Kastl, Jens Maus, Jérôme Pech), from the
# OpenCCU repository at a pinned commit: a sparse checkout of buildroot-external/package/hmlangw only. It is built
# into the test image as the LAN-gateway front of stage 1b (its LICENSE travels along); nothing of it is vendored here.
#
# Usage: fetch-hmlangw.sh <repo-url> <commit> <destdir>
#
set -euo pipefail

REPO=${1:?usage: $0 <repo-url> <commit> <destdir>}
COMMIT=${2:?missing commit}
DEST=${3:?missing destdir}
PKG=buildroot-external/package/hmlangw

if [[ -e ${DEST} ]]; then
  echo "ERROR: ${DEST} already exists" >&2
  exit 1
fi

tmp=$(mktemp -d)
git init -q "${tmp}"
git -C "${tmp}" remote add origin "${REPO}"
git -C "${tmp}" sparse-checkout set --no-cone "/${PKG}/"
git -C "${tmp}" fetch -q --depth 1 --filter=blob:none origin "${COMMIT}"
git -C "${tmp}" -c advice.detachedHead=false checkout -q FETCH_HEAD

for f in hmlangw.cpp hmframe.cpp hmframe.h Makefile LICENSE; do
  if [[ ! -e ${tmp}/${PKG}/${f} ]]; then
    echo "ERROR: ${PKG}/${f} missing at ${COMMIT}" >&2
    exit 1
  fi
done
if ! grep -q 'MIT License' "${tmp}/${PKG}/LICENSE"; then
  echo "ERROR: hmlangw's LICENSE is not the MIT licence any more; stop and look" >&2
  exit 1
fi

mkdir -p "${DEST}"
cp "${tmp}/${PKG}"/hmlangw.cpp "${tmp}/${PKG}"/hmframe.cpp "${tmp}/${PKG}"/hmframe.h "${tmp}/${PKG}"/Makefile \
   "${tmp}/${PKG}"/LICENSE "${DEST}/"
echo "${COMMIT}" >"${DEST}/.commit"
rm -rf "${tmp}"
echo "fetched hmlangw from ${REPO} ${COMMIT} to ${DEST}"
