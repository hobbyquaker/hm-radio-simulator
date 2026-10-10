#!/bin/bash
#
# Builds rfd and hs485d (with the libraries they load) from an OpenCCU-Base checkout for the host architecture with
# the Base's own CMake project, into a staging directory with bin/ and lib/. On main, where components are selectable,
# only rfd and hs485d are selected (the libraries follow the link graph); on 3.89.11 the extra options are unused and
# the two targets are built out of the whole tree.
#
# Usage: build-daemons.sh <openccu-base dir> release|asan|coverage <output dir>
#
#   release   -O2, as the firmware builds them (gcc)
#   asan      AddressSanitizer and UndefinedBehaviorSanitizer, debug info, -O1 (gcc)
#   coverage  clang's source-based coverage (-fprofile-instr-generate -fcoverage-mapping), -O0, in continuous mode
#             (-mllvm -runtime-counter-relocation with a %c in LLVM_PROFILE_FILE): the counters live in an mmapped
#             .profraw per process and object, so a daemon stopped with SIGTERM - neither rfd nor hs485d handles it -
#             loses nothing; llvm-profdata merges them, llvm-cov exports, see scripts/coverage.sh
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
  coverage)
    build_type=Debug
    flags="-fprofile-instr-generate -fcoverage-mapping -mllvm -runtime-counter-relocation -O0 -g"
    export CC=clang CXX=clang++
    ;;
  *)
    echo "unknown variant ${VARIANT} (release|asan|coverage)" >&2
    exit 1
    ;;
esac

BUILD="${SRC}/build-${VARIANT}"
mkdir -p "${OUT}"
cmake -S "${SRC}" -B "${BUILD}" \
  -DTARGET_PLATFORM=x86_64-linux-gnu \
  -DCROSS_PREFIX= \
  -DDEPLOY_TO_REPO=OFF \
  -DBUILD_DEFAULT_COMPONENTS=OFF \
  -DBUILD_RFD=ON \
  -DBUILD_HS485D=ON \
  -DBUILD_TCL_MODULES=OFF \
  -DBUILD_WEBUI_AND_DEVICETYPES=OFF \
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
