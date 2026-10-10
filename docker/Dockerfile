# hm-radio-simulator test environment
#
# Fetches OpenCCU-Base at BASE_REF, builds rfd and hs485d with their libraries (a release build and an ASan/UBSan
# build) and packs them with the device descriptions, socat for the pty, and this test suite.
#
#   docker build -f docker/Dockerfile --target test --build-arg BASE_REF=3.89.11 -t hm-radio-simulator .
#   docker run --rm --init -v "$PWD/results:/results" hm-radio-simulator
#   docker run --rm --init -e HMRS_VARIANT=asan hm-radio-simulator
#
#   docker build -f docker/Dockerfile --target fuzz --build-arg BASE_REF=main -t hm-radio-simulator-fuzz .
#   docker run --rm -e FUZZ_SECONDS=60 -v "$PWD/results/fuzz:/results" hm-radio-simulator-fuzz
#
# Build arguments:
#   BASE_REPO     OpenCCU-Base git repository
#   BASE_REF      branch, tag or commit of OpenCCU-Base to test (default 3.89.11)
#   KNOWN_BROKEN  OpenCCU-Base issue numbers (or named findings without an issue yet, e.g. double-join) known to be
#                 unfixed in that ref; their regression tests run as todo
#   NODE_IMAGE    the node base image
#
# The OpenCCU-Base sources (HMSL 2, LGPL, GPL) are fetched at build time and stay in the image.
#
# Debian trixie on purpose: the sanitizer runtimes of bookworm (LLVM 14, GCC 12) crash at start-up on kernels that
# randomise mmap with 32 bits (the ASan allocator's fixed region collides with the random layout), which looked like
# a flaky segfault in every fourth run; trixie's LLVM 19 and GCC 14 runtimes handle it.
ARG NODE_IMAGE=node:22-trixie-slim

# the OpenCCU-Base sources
FROM debian:trixie-slim AS base-src
ARG BASE_REPO=https://github.com/OpenCCU/OpenCCU-Base.git
ARG BASE_REF=3.89.11
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-openccu-base.sh /usr/local/bin/
RUN fetch-openccu-base.sh "${BASE_REPO}" "${BASE_REF}" /openccu-base

# the daemons, release and asan
FROM debian:trixie-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake make g++ libssl-dev \
 && rm -rf /var/lib/apt/lists/*
COPY --from=base-src /openccu-base /openccu-base
COPY scripts/build-daemons.sh /usr/local/bin/
RUN build-daemons.sh /openccu-base release /opt/daemons/release
RUN build-daemons.sh /openccu-base asan /opt/daemons/asan

# the libFuzzer harnesses (a separate target)
FROM ${NODE_IMAGE} AS fuzz
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang libclang-rt-dev \
 && rm -rf /var/lib/apt/lists/*
COPY --from=base-src /openccu-base /openccu-base
WORKDIR /opt/hm-radio-simulator
COPY fuzz fuzz
COPY lib lib
COPY scripts/make-fuzz-seeds.mjs scripts/
COPY package.json .
RUN fuzz/build.sh /openccu-base /opt/fuzz/bin \
 && node scripts/make-fuzz-seeds.mjs /opt/fuzz/seeds \
 && mkdir -p /opt/openccu-base && cp /openccu-base/.openccu-base-commit /opt/openccu-base/commit \
 && cp /openccu-base/.openccu-base-ref /opt/openccu-base/ref
ENV FUZZ_BIN=/opt/fuzz/bin FUZZ_SEEDS=/opt/fuzz/seeds
VOLUME /results
CMD ["fuzz/run.sh"]

# the test environment
FROM ${NODE_IMAGE} AS test
ARG KNOWN_BROKEN=115,116,138,140,double-join
RUN apt-get update \
 && apt-get install -y --no-install-recommends socat procps libasan8 libubsan1 libssl3 ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/daemons /opt/daemons
COPY --from=base-src /openccu-base/src/devicetypes/rftypes /opt/openccu-base/rftypes
COPY --from=base-src /openccu-base/src/devicetypes/hs485types /opt/openccu-base/hs485types
COPY --from=base-src /openccu-base/licenses /opt/openccu-base/licenses
COPY --from=base-src /openccu-base/.openccu-base-commit /opt/openccu-base/commit
COPY --from=base-src /openccu-base/.openccu-base-ref /opt/openccu-base/ref
ENV HMRS_RFTYPES=/opt/openccu-base/rftypes \
    HMRS_HS485TYPES=/opt/openccu-base/hs485types \
    HMRS_KNOWN_BROKEN=${KNOWN_BROKEN} \
    TZ=Europe/Berlin
WORKDIR /opt/hm-radio-simulator
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN chmod +x scripts/*.sh fuzz/*.sh
VOLUME /results
ENTRYPOINT ["scripts/docker-entrypoint.sh"]
CMD ["npm", "run", "test:daemon"]
