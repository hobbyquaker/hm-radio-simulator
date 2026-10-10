---
status: draft
component: libelvutils (Actor), rfd
refs: [3.89.11 (3ed652a), main (030dba7)]
suite: double-join
---

# `Actor::Stop()` joins the dispatcher thread a second time; under ASan rfd aborts on `init(url, "")`

## What happens

Deregistering an event receiver (`init("xmlrpc_bin://host:port", "")`) tears its event dispatcher down. Under
AddressSanitizer, rfd aborts at that moment; the sanitizer's pthread interceptor reports the join of a thread that was
joined already. The release build does not notice: the second `pthread_join()` fails and the return value is not
checked. The behaviour is the same on 3.89.11 and main.

## How to reproduce

The suite's test `init with an empty id deregisters the receiver and rfd stays up (the double-join finding under ASan)`
in `test/daemon/rfd-rpc.test.js`:

```sh
scripts/run-tests.sh --ref main --variants asan
docker run --rm --init --cap-add SYS_NICE -e HMRS_VARIANT=asan -e HMRS_KNOWN_BROKEN= hm-radio-simulator:main \
  node --test --test-name-pattern 'deregisters the receiver' test/daemon/rfd-rpc.test.js
```

By hand: start an ASan build of rfd, register a receiver with `init(url, "id")`, deregister it with `init(url, "")`.

## Expected

The receiver goes away and rfd keeps running, in every build.

## Cause (public source)

`Actor::Stop()` only guards the signalling with `m_isRunning`; the `pthread_join()` below it runs every time:
[Actor.cpp:100-118 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libelvutils/Actor.cpp#L100-L118).
`~Actor()` calls `Stop()` again
([Actor.cpp:29-33](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/libelvutils/Actor.cpp#L29-L33)),
so an actor that was stopped explicitly before it is destroyed - the receiver's dispatcher - joins its thread twice.
Joining a joined thread is undefined behaviour (POSIX), which is what the sanitizer catches. The same code is on
[main](https://github.com/OpenCCU/OpenCCU-Base/blob/030dba79b5e76cb10178a20e87a1b050df09faa9/src/libelvutils/Actor.cpp#L100-L118).

## Proposed fix

Make `Stop()` idempotent: join only when the thread was started and not joined yet, e.g. keep a `m_joined` flag (or
reset `m_thread` to 0 after the join) and skip the `pthread_join()` otherwise. Checking the return value of
`pthread_join()` would make the release build log it too.
