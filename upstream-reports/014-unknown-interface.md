---
status: reported: https://github.com/OpenCCU/OpenCCU-Base/issues/174
component: rfd
refs: [3.89.11 (3ed652a), main (570566e)]
suite: unknown-interface
---

# rfd: setBidcosInterface accepts an interface that does not exist, reports success and stores it

## What happens

`setBidcosInterface(device, interface, roaming)` with an interface serial that is not configured (a typo, an
interface removed from `rfd.conf`, an HM-LGW that was replaced) returns without a fault. rfd stores the given string as
the device's interface: `getDeviceDescription` reports it as `INTERFACE`, and it is written into the device file
(`bidcos_interface`). The device itself is put on the **default** interface, because
`BidcosInterfaceConcentrator::AddDevice()` falls back to it when the named interface is unknown. So the caller is told
the device is now on an interface that does not exist, while it actually talks through another one - and a user
interface that shows `INTERFACE` shows a name that is nowhere in `listBidcosInterfaces`.

Measured with rfd 3.89.11 and two simulated interfaces (a module on a pty and a LAN gateway): the device on interface
A, `setBidcosInterface(serial, "NOSUCHIFACE", false)` answers with an empty result, `INTERFACE` is `NOSUCHIFACE`
afterwards, the module of the default interface gets `ADD_LINK_PEER` for the device.

## How to reproduce

In the suite: `test/daemon/rfd-two-interfaces.test.js`, "setBidcosInterface with an interface that does not exist is
refused". Runs as `todo` under the name `unknown-interface`. With a plain client: any rfd with one interface,
`setBidcosInterface("<a paired device>", "NOSUCHIFACE", false)`, then `getDeviceDescription`.

## Expected

A fault (e.g. -2 "Unknown interface", as `deleteDevice` answers an unknown address), and the device's interface
unchanged.

## Cause (public source)

`RFDevice::SetBidcosInterface()` assigns the id and returns `true` without asking the concentrator whether the
interface exists
([RFDevice.cpp:1391-1399 at 3.89.11](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/RFDevice.cpp#L1391-L1399));
`BidcosInterfaceConcentrator::AddDevice()` then silently uses the default interface
([BidcosInterfaceConcentrator.cpp:697-701](https://github.com/OpenCCU/OpenCCU-Base/blob/3ed652a404d72cbe403e37c5b8b1f610451b02fb/src/rfd/BidcosInterfaceConcentrator.cpp#L697-L701)).
Unchanged on main
([RFDevice.cpp:1391-1399](https://github.com/OpenCCU/OpenCCU-Base/blob/570566e3fa0979698b83d0b6714997f78e8f9979/src/rfd/RFDevice.cpp#L1391-L1399)).

## Proposed fix

In `RFDevice::SetBidcosInterface()` (or `RFManager::SetBidcosInterface()`): when `interface_id` is not empty and
`GetInterfaceConcentrator()->GetInterface(interface_id)` is null, throw `XmlRpcException("Unknown interface", -2)`
before changing anything. The fallback in `AddDevice()` stays for device files that name an interface which is gone.
