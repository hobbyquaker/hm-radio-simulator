---
status: draft
component: libXmlRpc (rfd, hs485d)
refs: [3.89.11 (3ed652a), main (570566e)]
suite: xmlrpc-select-fd
---

# libXmlRpc: the RPC server stops answering once its sockets have descriptors of 1024 or more (select() with fd_set)

## What happens

`XmlRpcDispatch::work()` waits for its sources with `select()` on `fd_set`s. An `fd_set` holds descriptors 0..1023
(`FD_SETSIZE`); `FD_SET()` with a larger descriptor writes past the end of the set on the stack, and `select()` then
reads `maxFd + 1` bits from memory that is not the set. Once the server socket (or a client connection) of rfd or
hs485d gets a descriptor of 1024 or more, the dispatcher never sees it readable: the RPC server accepts nothing and
answers nothing, while the rest of the daemon keeps running.

The LAN-gateway connection had the same problem and was fixed by e097a3c1 ("Replace select() with poll() in
connection handling", `LanConnection::waitForData`); the RPC dispatcher was not changed.

Measured with rfd (3.89.11 and main) started with descriptors 3..1099 already open (and `ulimit -n` raised), so every
descriptor rfd opens itself is 1100 or higher: the HM-LGW connection on both ports and the coprocessor init work (that
is e097a3c1's `poll()`), but `system.listMethods` gets no answer within 20 s. The same start with descriptors up to 899
open: everything works. Under AddressSanitizer the write past the set is caught: "stack-buffer-overflow ... in
XmlRpc::XmlRpcDispatch::work(int) XmlRpcDispatch.cpp:104" (the `FD_SET` line), called from rfd's main loop, and rfd
aborts.

A daemon reaches such descriptors when it is started by a process that leaks descriptors into it, or with many
concurrent RPC connections and open files; on a CCU this is rare, but the failure is silent (the daemon looks alive).

## How to reproduce

In the suite: `test/daemon/rfd-lgw-recovery.test.js`, "AES: rfd started with 1100 descriptors open - ...", subtest
"the RPC server answers" (todo under the name `xmlrpc-select-fd`; the same test with 900 descriptors passes). By hand:

```sh
bash -c 'ulimit -n 4096; for ((i = 3; i < 1100; i++)); do eval "exec $i</dev/null"; done; exec rfd -f rfd.conf -c'
```

and call any RPC method on rfd's port.

## Expected

The RPC server works with any descriptor the process limit allows, as the LAN-gateway code does since e097a3c1.

## Cause (public source)

[XmlRpcDispatch.cpp:93-128 at main](https://github.com/OpenCCU/OpenCCU-Base/blob/570566e3fa0979698b83d0b6714997f78e8f9979/src/libXmlRpc/src/XmlRpcDispatch.cpp#L93-L128):
`fd_set inFd, outFd, excFd`, `FD_SET(fd, ...)` for every source without a check against `FD_SETSIZE`, then
`select(maxFd+1, ...)`; the results are read back with `FD_ISSET` (line 150 ff.). Unchanged since 3.89.11.

## Proposed fix

Build a `std::vector<pollfd>` from the sources in `XmlRpcDispatch::work()` (`POLLIN` for `ReadableEvent`, `POLLOUT`
for `WritableEvent`, `POLLPRI` for `Exception`) and call `poll()` with the same timeout rule (0 when data is pending,
`msTime`, or -1); map `revents` back to the sources instead of `FD_ISSET`. That is the change e097a3c1 made in
`LanConnection::waitForData`. At the least, refuse a source whose descriptor is `>= FD_SETSIZE` with an error instead
of writing past the set.
