# hm-radio-simulator test environment
#
# Fetches OpenCCU-Base at BASE_REF, builds rfd and hs485d with their libraries (a release build and an ASan/UBSan
# build) and packs them with the device descriptions, socat for the pty, and this test suite.
#
#   docker build -f docker/Dockerfile --target test --build-arg BASE_REF=3.89.11 -t hm-radio-simulator .
#   docker run --rm --init --cap-add SYS_NICE -v "$PWD/results:/results" hm-radio-simulator
#   docker run --rm --init --cap-add SYS_NICE -e HMRS_VARIANT=asan hm-radio-simulator
#   docker run --rm --init --cap-add SYS_NICE -e HMRS_VARIANT=coverage -v "$PWD/results:/results" hm-radio-simulator
#
# SYS_NICE: hmlangw (the LAN-gateway front of stage 1b) starts its threads with SCHED_RR, which docker's default
# capability set refuses; without the capability it exits silently with code 1 and the LGW tests fail at start.
#
#   docker build -f docker/Dockerfile --target fuzz --build-arg BASE_REF=main -t hm-radio-simulator-fuzz .
#   docker run --rm -e FUZZ_SECONDS=60 -v "$PWD/results/fuzz:/results" hm-radio-simulator-fuzz
#
# Build arguments:
#   BASE_REPO     OpenCCU-Base git repository
#   BASE_REF      branch, tag or commit of OpenCCU-Base to test (default 3.89.11)
#   BASE_LABEL    what the image reports as the ref (default BASE_REF): a commit tested for main is labelled main
#   HMLANGW_REPO  the OpenCCU repository hmlangw (MIT) is fetched from
#   HMLANGW_REF   its commit
#   KNOWN_BROKEN  OpenCCU-Base issue numbers (or named findings without an issue yet, e.g. double-join) known to be
#                 unfixed in that ref; their regression tests run as todo
#   DAEMON_VARIANTS  the daemon variants to build (default "release asan coverage"; release and asan are always built)
#   NODE_IMAGE    the node base image
#
# The OpenCCU-Base sources (HMSL 2, LGPL, GPL) and hmlangw (MIT) are fetched at build time and stay in the image.
#
# Debian trixie on purpose: the sanitizer runtimes of bookworm (LLVM 14, GCC 12) crash at start-up on kernels that
# randomise mmap with 32 bits (the ASan allocator's fixed region collides with the random layout), which looked like
# a flaky segfault in every fourth run; trixie's LLVM 19 and GCC 14 runtimes handle it.
ARG NODE_IMAGE=node:22-trixie-slim

# the OpenCCU-Base sources
FROM debian:trixie-slim AS base-src
ARG BASE_REPO=https://github.com/OpenCCU/OpenCCU-Base.git
ARG BASE_REF=3.89.11
ARG BASE_LABEL=
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-openccu-base.sh /usr/local/bin/
RUN fetch-openccu-base.sh "${BASE_REPO}" "${BASE_REF}" /openccu-base "${BASE_LABEL:-${BASE_REF}}"

# hmlangw, the HM-LGW emulation (MIT), for the LAN-gateway stage
FROM debian:trixie-slim AS hmlangw-src
ARG HMLANGW_REPO=https://github.com/OpenCCU/OpenCCU.git
ARG HMLANGW_REF=ea5fe2e6a4eea6ee045dbfbd7675560c4d2c5dc8
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-hmlangw.sh /usr/local/bin/
RUN fetch-hmlangw.sh "${HMLANGW_REPO}" "${HMLANGW_REF}" /hmlangw

# the daemons - release and asan (gcc), coverage (clang, source-based coverage) - and hmlangw
FROM debian:trixie-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake make g++ libssl-dev clang libclang-rt-dev \
 && rm -rf /var/lib/apt/lists/*
COPY --from=base-src /openccu-base /openccu-base
COPY scripts/build-daemons.sh /usr/local/bin/
RUN build-daemons.sh /openccu-base release /opt/daemons/release
RUN build-daemons.sh /openccu-base asan /opt/daemons/asan
# DAEMON_VARIANTS: the proof images (scripts/prove.mjs) need release and asan only and leave coverage out
ARG DAEMON_VARIANTS="release asan coverage"
RUN case " ${DAEMON_VARIANTS} " in \
      *" coverage "*) build-daemons.sh /openccu-base coverage /opt/daemons/coverage ;; \
      *) echo "coverage variant not built (DAEMON_VARIANTS=${DAEMON_VARIANTS})" ;; \
    esac
# the fault shim (test scaffolding: read()/select() on one device fail with a chosen errno; shim/hmrs-faults.c)
COPY shim/hmrs-faults.c /tmp/hmrs-faults.c
RUN mkdir -p /opt/hmrs && gcc -shared -fPIC -O2 -Wall -o /opt/hmrs/libhmrs-faults.so /tmp/hmrs-faults.c -ldl
COPY --from=hmlangw-src /hmlangw /hmlangw
RUN make -C /hmlangw CXXFLAGS="-Wall -O2 -pipe" hmlangw \
 && install -D -m 0755 /hmlangw/hmlangw /opt/hmlangw/bin/hmlangw \
 && install -D -m 0644 /hmlangw/LICENSE /opt/hmlangw/LICENSE \
 && cp /hmlangw/.commit /opt/hmlangw/commit

# the libFuzzer harnesses (a separate target)
FROM ${NODE_IMAGE} AS fuzz
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang libclang-rt-dev llvm \
 && rm -rf /var/lib/apt/lists/*
COPY --from=base-src /openccu-base /openccu-base
WORKDIR /opt/hm-radio-simulator
COPY fuzz fuzz
COPY lib lib
COPY scripts/make-fuzz-seeds.mjs scripts/fuzz-summary.mjs scripts/
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
ARG KNOWN_BROKEN=63,115,116,138,140,double-join,read-eof,aes-republish,wired-maintenance,metadata-args,string-uint-conversion,replace-callback,init-blocks,async-callback-threads,dutycycle-upper-bound,flush-drops-events,unknown-interface,json-substr,hexfile-no-data,propertymap-long-line,xmlrpc-select-fd,system-command-slot
RUN apt-get update \
 && apt-get install -y --no-install-recommends socat procps libasan8 libubsan1 libssl3 ca-certificates tzdata llvm \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/daemons /opt/daemons
COPY --from=build /opt/hmlangw /opt/hmlangw
COPY --from=build /opt/hmrs /opt/hmrs
COPY --from=base-src /openccu-base/src/devicetypes/rftypes /opt/openccu-base/rftypes
COPY --from=base-src /openccu-base/src/devicetypes/hs485types /opt/openccu-base/hs485types
COPY --from=base-src /openccu-base/licenses /opt/openccu-base/licenses
COPY --from=base-src /openccu-base/.openccu-base-commit /opt/openccu-base/commit
COPY --from=base-src /openccu-base/.openccu-base-ref /opt/openccu-base/ref
# the daemons' RPC dispatcher sources, for the method sweep's table (scripts/method-table.mjs below)
COPY --from=base-src /openccu-base/src/rfd/XmlRpcMethods.cpp /openccu-base/src/rfd/rfd.cpp /opt/openccu-base/methods-src/rfd/
COPY --from=base-src /openccu-base/src/hs485d/XmlRpcMethods.cpp /openccu-base/src/hs485d/hs485d.cpp /opt/openccu-base/methods-src/hs485d/
ENV HMRS_RFTYPES=/opt/openccu-base/rftypes \
    HMRS_HS485TYPES=/opt/openccu-base/hs485types \
    HMRS_HMLANGW=/opt/hmlangw/bin/hmlangw \
    HMRS_FAULT_SHIM=/opt/hmrs/libhmrs-faults.so \
    HMRS_KNOWN_BROKEN=${KNOWN_BROKEN} \
    HMRS_METHODS=/opt/openccu-base/methods \
    TZ=Europe/Berlin
WORKDIR /opt/hm-radio-simulator
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN chmod +x scripts/*.sh fuzz/*.sh \
 && mkdir -p /opt/openccu-base/methods \
 && for d in rfd hs485d; do \
      node scripts/method-table.mjs /opt/openccu-base/methods-src/$d/*.cpp > /opt/openccu-base/methods/$d.json || exit 1; \
      node scripts/method-table.mjs --all /opt/openccu-base/methods-src/$d/*.cpp > /opt/openccu-base/methods/$d-all.json || exit 1; \
    done
VOLUME /results
ENTRYPOINT ["scripts/docker-entrypoint.sh"]
CMD ["npm", "run", "test:daemon"]
