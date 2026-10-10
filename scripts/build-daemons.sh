#!/bin/bash
#
# Builds rfd and hs485d (with the libraries they load) from an OpenCCU-Base checkout for the host architecture with
# the Base's own CMake project, into a staging directory with bin/ and lib/.
#
# Usage: build-daemons.sh <openccu-base dir> release|asan <output dir>
#
#   release  -O2, as the firmware builds them
#   asan     AddressSanitizer and UndefinedBehaviorSanitizer, debug info, -O1
#
set -euo pipefail

SRC=${1:?usage: $0 <openccu-base dir> release|asan <output dir>}
VARIANT=${2:?missing variant}
OUT=${3:?missing output dir}

case "${VARIANT}" in
  release)
    build_type=Release
    flags=""
    ;;
  asan)
    build_type=RelWithDebInfo
    flags="-fsanitize=address,undefined -fno-omit-frame-pointer -O1 -g"
    ;;
  *)
    echo "unknown variant ${VARIANT} (release|asan)" >&2
    exit 1
    ;;
esac

BUILD="${SRC}/build-${VARIANT}"
mkdir -p "${OUT}"
cmake -S "${SRC}" -B "${BUILD}" \
  -DTARGET_PLATFORM=x86_64-linux-gnu \
  -DCROSS_PREFIX= \
  -DDEPLOY_TO_REPO=OFF \
  -DROOTFS_DIR="${OUT}" \
  -DCMAKE_BUILD_TYPE="${build_type}" \
  -DCMAKE_C_FLAGS="${flags}" \
  -DCMAKE_CXX_FLAGS="${flags}" \
  -DCMAKE_EXE_LINKER_FLAGS="${flags}" \
  -DCMAKE_SHARED_LINKER_FLAGS="${flags}"
cmake --build "${BUILD}" --target rfd hs485d -j"$(nproc)"

for f in bin/rfd bin/hs485d lib/libXmlRpc.so lib/libxmlparser.so; do
  if [[ ! -e ${OUT}/${f} ]]; then
    echo "ERROR: ${f} missing after the build" >&2
    exit 1
  fi
done
cp "${SRC}/.openccu-base-commit" "${OUT}/commit"
echo "${VARIANT}" >"${OUT}/variant"
rm -rf "${BUILD}"
echo "built ${VARIANT} daemons into ${OUT}: $(ls "${OUT}/bin") / $(ls "${OUT}/lib" | tr '\n' ' ')"
