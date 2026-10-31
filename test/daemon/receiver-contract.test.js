/**
 * The receiver contract: what every logic layer (hm2mqtt, node-red-contrib-ccu, homematic-manager, occulited, ReGa)
 * relies on when it registers with `init` - for rfd and hs485d, which share it through libhsscomm's HSSManager and
 * HSSXmlRpcEventDispatcher (public source, read for the expectations below):
 *
 * - every receiver gets its own dispatcher thread: events are batched into `system.multicall`, in order;
 * - `init(url, id)` asks the receiver for `system.listMethods` and `listDevices`, then sends `newDevices` with the
 *   devices the receiver lacks or knows with another VERSION, `deleteDevices` with those it knows and the daemon does
 *   not, `replaceDevice` for replaced ones (if the receiver lists the method), and re-sends the service messages;
 * - `ping(callerId)` sends the event (CENTRAL, PONG, callerId) to every receiver;
 * - a receiver whose batches fail ten times in a row (each tried twice) is marked unreachable and removed at the next
 *   event; a fault does not count, a success resets the count;
 * - the dispatcher's client waits 10 s for an answer, so a hanging receiver delays only itself.
 *
 * Timing assumptions: the event dispatcher sends within a few hundred ms of the event (no fixed delay in the source);
 * a refused connection fails at once. Margins of seconds; the stalled-receiver test allows 2 s per event where the
 * dispatcher's own timeout is 10 s.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    startRfd,
    startHs485d,
    withDaemon,
    skipWithoutDaemons,
    DAEMONS,
    RFTYPES,
    HS485TYPES,
} from '../helpers/daemon.js';
import {startReceiver} from '../helpers/rpc.js';
import {regression} from '../helpers/known.js';
import {attachSwitch, pairSwitch, waitForEvent, SWITCH_SERIAL} from '../helpers/switch.js';
import {loadDeviceDescription} from '../../lib/rftypes.js';
import {WiredBus, WiredDevice} from '../../lib/wired.js';
import {announcement} from '../helpers/sweep.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ASAN = DAEMONS.endsWith('asan');

/** The two daemons, each with what the contract tests need to know about it. */
const FLAVOURS = [
    {
        name: 'rfd',
        central: 'BidCoS-RF',
        handlers: 'rfd.handlers',
        initArgs: (url, id) => [url, id],
        async start() {
            return startRfd();
        },
        /** two virtual switches of one type: the old and its replacement */
        async replacePair(rfd) {
            const description = loadDeviceDescription(path.join(RFTYPES, 'rf_s.xml'));
            for (const [serial, address] of [
                ['SWPOLD0001', 0x4f1001],
                ['SWPNEW0001', 0x4f1002],
            ]) {
                const added = await rfd.call('addVirtualDeviceInstance', [
                    [...announcement(description, 'HM-LC-Sw1-Pl', address, serial)],
                ]);
                assert.equal(added, true);
            }
            return ['SWPOLD0001', 'SWPNEW0001'];
        },
    },
    {
        name: 'hs485d',
        central: 'BidCoS-Wir',
        handlers: 'hs485d.handlers',
        // the third argument is dont_callback: false = ask the receiver and send newDevices
        initArgs: (url, id) => [url, id, false],
        async start() {
            // two switches of one type: the second is the replacement in the replaceDevice test
            const bus = new WiredBus();
            const description = loadDeviceDescription(path.join(HS485TYPES, 'hmw_lc_sw2_dr.xml'));
            for (const [serial, address] of [
                ['SIMW000001', 0x00004711],
                ['SIMW000002', 0x00004712],
            ]) {
                bus.add(
                    new WiredDevice({
                        address,
                        serial,
                        description,
                        typeId: 'HMW-LC-Sw2-DR',
                        sysinfo: [0x11, 0x00, 0x03, 0x05],
                    }),
                );
            }
            const hs485d = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus});
            try {
                assert.equal(await hs485d.call('searchDevices', [], {timeout: 60000}), 2);
            } catch (error) {
                await hs485d.stop();
                throw error;
            }
            return hs485d;
        },
        async replacePair() {
            return ['SIMW000001', 'SIMW000002'];
        },
    },
];

/** init with the daemon's argument list, then wait for the newDevices that ends the sync. */
async function register(flavour, daemon, receiver, id) {
    await daemon.call('init', flavour.initArgs(receiver.url, id), {timeout: 30000});
    await receiver.waitFor('newDevices', 15000);
}

/** The PONG values a receiver got, in order. */
function pongs(receiver) {
    return receiver.received
        .filter((r) => r.method === 'event' && r.params[1] === 'CENTRAL' && r.params[2] === 'PONG')
        .map((r) => r.params[3]);
}

async function waitForPong(receiver, value, timeout = 10000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (pongs(receiver).includes(value)) {
            return Date.now();
        }
        await sleep(20);
    }
    throw new Error(`no PONG ${value} within ${timeout} ms; got ${pongs(receiver).join(' ') || 'none'}`);
}

async function stopAll(receivers) {
    for (const r of receivers) {
        await r.stop().catch(() => {});
    }
}

for (const flavour of FLAVOURS) {
    test(
        `${flavour.name}: three receivers - each is synced with its own id; ping sends PONG to all; 20 events arrive in order at each`,
        {...skipWithoutDaemons, timeout: 240000},
        async (t) => {
            const daemon = await flavour.start();
            const receivers = [await startReceiver(), await startReceiver(), await startReceiver()];
            await withDaemon(daemon, async () => {
                for (const [i, r] of receivers.entries()) {
                    await register(flavour, daemon, r, `contract-${i}`);
                }
                for (const [i, r] of receivers.entries()) {
                    assert.ok(r.calls('system.listMethods').length >= 1, `receiver ${i} was asked for its methods`);
                    assert.equal(r.calls('listDevices')[0].params[0], `contract-${i}`);
                    const nd = r.calls('newDevices')[0];
                    assert.equal(nd.params[0], `contract-${i}`, 'newDevices carries the receiver id');
                    assert.ok(nd.params[1].some((d) => d.ADDRESS === flavour.central));
                }
                const values = Array.from({length: 20}, (_, i) => `order-${i}`);
                for (const v of values) {
                    await daemon.call('ping', [v]);
                }
                for (const [i, r] of receivers.entries()) {
                    await waitForPong(r, values.at(-1));
                    assert.deepEqual(pongs(r), values, `receiver ${i}: every PONG, in order`);
                    const ids = r.received
                        .filter((e) => e.method === 'event' && e.params[2] === 'PONG')
                        .map((e) => e.params[0]);
                    assert.ok(
                        ids.every((id) => id === `contract-${i}`),
                        `events carry the receiver's id: ${[...new Set(ids)]}`,
                    );
                }
                const batches = receivers[0].calls('system.multicall').length;
                t.diagnostic(`receiver 0 got the 20 PONGs in ${batches} system.multicall batches`);
                assert.ok(daemon.alive);
            }).finally(() => stopAll(receivers));
        },
    );

    test(
        `${flavour.name}: init sync - the receiver's listDevices decides: unknown addresses deleted, another VERSION re-sent, the same VERSION left out`,
        {...skipWithoutDaemons, timeout: 240000},
        async (t) => {
            const daemon = await flavour.start();
            let receiver = null;
            await withDaemon(daemon, async () => {
                const local = await daemon.call('listDevices');
                const central = local.find((d) => d.ADDRESS === flavour.central);
                const other = local.find((d) => d.ADDRESS !== flavour.central && !d.ADDRESS.includes(':'));
                assert.ok(central, 'the central is listed');
                const known = [
                    {ADDRESS: 'GHOST00001', VERSION: 1},
                    {ADDRESS: central.ADDRESS, VERSION: central.VERSION},
                ];
                if (other) {
                    known.push({ADDRESS: other.ADDRESS, VERSION: other.VERSION + 1});
                }
                receiver = await startReceiver({methods: {listDevices: () => known}});
                await register(flavour, daemon, receiver, 'contract-sync');
                const sent = receiver.calls('newDevices')[0].params[1].map((d) => d.ADDRESS);
                assert.ok(!sent.includes(central.ADDRESS), 'the central with the same VERSION is not sent again');
                if (other) {
                    assert.ok(sent.includes(other.ADDRESS), `${other.ADDRESS} with another VERSION is sent again`);
                }
                assert.ok(
                    sent.includes(`${central.ADDRESS}:1`),
                    "the central's channels, unknown to the receiver, are sent",
                );
                await receiver.waitFor('deleteDevices', 10000);
                const deleted = receiver.calls('deleteDevices')[0];
                assert.equal(deleted.params[0], 'contract-sync');
                assert.deepEqual(deleted.params[1], ['GHOST00001']);
                t.diagnostic(`newDevices: ${sent.length} addresses; deleteDevices: ${deleted.params[1]}`);
            }).finally(() => receiver && receiver.stop());
        },
    );

    test(
        `${flavour.name}: the unreachable rule - ten failed deliveries in a row remove a receiver at the next event, a success resets the count${ASAN ? ' (#269, #161 under ASan)' : ''}`,
        {...skipWithoutDaemons, ...(ASAN ? regression(269) : {}), timeout: 300000},
        async (t) => {
            const daemon = await flavour.start();
            const steady = await startReceiver();
            const flaky = await startReceiver();
            const handlersFile = path.join(daemon.workdir, flavour.handlers);
            let n = 0;
            const removed = () =>
                daemon.grep(
                    new RegExp(`Removing unreachable XMLRPC handler with url ${flaky.url.replace(/\./g, '\\.')}`),
                ).length > 0;
            /** one event; waits until the steady receiver has it, so each event is one batch for the flaky one */
            const event = async () => {
                const value = `unreach-${++n}`;
                await daemon.call('ping', [value]);
                await waitForPong(steady, value);
                await sleep(150);
                return value;
            };
            await withDaemon(daemon, async () => {
                await register(flavour, daemon, steady, 'contract-steady');
                await register(flavour, daemon, flaky, 'contract-flaky');
                assert.ok(fs.readFileSync(handlersFile, 'utf8').includes(flaky.url), 'both receivers persisted');
                const port = flaky.port;

                // nine failures, then the receiver is back for one event: the count starts again
                await flaky.stop();
                for (let i = 0; i < 9; i++) {
                    await event();
                }
                assert.ok(!removed(), 'not removed after nine failures');
                await flaky.start(port);
                const back = await event();
                await waitForPong(flaky, back);

                // now ten failures in a row; the eleventh event removes it
                await flaky.stop();
                let removedAt = null;
                for (let i = 1; i <= 14 && removedAt === null; i++) {
                    await event();
                    if (removed()) {
                        removedAt = i;
                    }
                }
                t.diagnostic(`removed at the event number ${removedAt} after the second outage`);
                assert.ok(removedAt !== null, `not removed after 14 failed events\n${daemon.tail(20)}`);
                assert.ok(removedAt >= 11, `removed after ${removedAt} events: the success must have reset the count`);
                assert.ok(removedAt <= 12, `removed only at event ${removedAt} (expected the 11th)`);
                assert.ok(!fs.readFileSync(handlersFile, 'utf8').includes(flaky.url), 'gone from the handlers file');
                assert.ok(fs.readFileSync(handlersFile, 'utf8').includes(steady.url), 'the steady one stays');
                await event();
                assert.ok(daemon.alive, `the daemon died: ${JSON.stringify(daemon.exit)}`);
                assert.deepEqual(daemon.sanitizerReports(), []);
            }).finally(() => stopAll([steady, flaky]));
        },
    );

    test(
        `${flavour.name}: a hanging receiver delays only itself - the others get their events at once, RPC keeps answering`,
        {...skipWithoutDaemons, timeout: 240000},
        async (t) => {
            const daemon = await flavour.start();
            const steady = await startReceiver();
            const stuck = await startReceiver();
            await withDaemon(daemon, async () => {
                await register(flavour, daemon, steady, 'contract-steady');
                await register(flavour, daemon, stuck, 'contract-stuck');
                stuck.stalled = true;
                const delays = [];
                for (let i = 0; i < 5; i++) {
                    const at = Date.now();
                    await daemon.call('ping', [`stall-${i}`]);
                    const got = await waitForPong(steady, `stall-${i}`, 5000);
                    delays.push(got - at);
                    const rpcAt = Date.now();
                    await daemon.call('listDevices', [], {timeout: 5000});
                    delays.push(Date.now() - rpcAt);
                    await sleep(500);
                }
                t.diagnostic(`PONG / listDevices latencies while a receiver hangs: ${delays.join(' ')} ms`);
                assert.ok(
                    delays.every((d) => d < 2000),
                    `the hanging receiver held the others up: ${delays.join(' ')}`,
                );
                assert.ok(stuck.calls('system.multicall').length >= 1, 'the hanging receiver was called');
                assert.ok(daemon.alive);
            }).finally(() => {
                stuck.stalled = false;
                return stopAll([steady, stuck]);
            });
        },
    );
}

test(
    'rfd: service messages are re-sent to a receiver that registers later (UNREACH of a silent switch)',
    {...skipWithoutDaemons, timeout: 240000},
    async (t) => {
        const rfd = await startRfd();
        const first = await startReceiver();
        let late = null;
        await withDaemon(rfd, async () => {
            const {air, device} = attachSwitch(rfd);
            await rfd.call('init', [first.url, 'contract-first']);
            await pairSwitch(rfd, first, air, device);
            device.answering = false;
            await rfd.call('setValue', [`${SWITCH_SERIAL}:1`, 'STATE', true], {timeout: 30000}).catch(() => {});
            await waitForEvent(first, `${SWITCH_SERIAL}:0`, 'UNREACH', true, {timeout: 30000});
            const messages = await rfd.call('getServiceMessages');
            t.diagnostic(`service messages: ${JSON.stringify(messages)}`);
            late = await startReceiver();
            await rfd.call('init', [late.url, 'contract-late']);
            const unreach = await waitForEvent(late, `${SWITCH_SERIAL}:0`, 'UNREACH', true, {timeout: 15000});
            assert.equal(unreach.params[0], 'contract-late');
            await waitForEvent(late, `${SWITCH_SERIAL}:0`, 'STICKY_UNREACH', true, {timeout: 15000});
            const resent = late.received
                .filter((r) => r.method === 'event')
                .map((r) => `${r.params[1]} ${r.params[2]}`);
            t.diagnostic(`re-sent on init: ${resent.join(', ')}`);
            assert.equal(resent.length, messages.length, 'exactly the service messages');
        }).finally(() => stopAll([first, late].filter(Boolean)));
    },
);

for (const flavour of FLAVOURS) {
    test(
        `${flavour.name}: replaceDevice - every registered receiver is told replaceDevice(id, old, new) when it happens`,
        {...skipWithoutDaemons, timeout: 240000},
        async (t) => {
            const daemon = await flavour.start();
            const receivers = [await startReceiver(), await startReceiver()];
            await withDaemon(daemon, async () => {
                for (const [i, r] of receivers.entries()) {
                    await register(flavour, daemon, r, `contract-${i}`);
                }
                const [oldDevice, newDevice] = await flavour.replacePair(daemon);
                const replaced = await daemon.call('replaceDevice', [oldDevice, newDevice], {timeout: 30000});
                assert.equal(replaced, true);
                for (const [i, r] of receivers.entries()) {
                    const call = await r.waitFor('replaceDevice', 10000);
                    assert.deepEqual(call.params, [`contract-${i}`, oldDevice, newDevice]);
                    t.diagnostic(
                        `receiver ${i} after the replace: ${r.received
                            .slice(r.received.indexOf(call))
                            .map((c) => c.method)
                            .join(' ')}`,
                    );
                }
            }).finally(() => stopAll(receivers));
        },
    );

    test(
        `${flavour.name}: replaceDevice - a receiver that still lists the old device gets replaceDevice(old, new) at init, not deleteDevices (the replace-callback finding)`,
        {...skipWithoutDaemons, ...regression('replace-callback'), timeout: 240000},
        async (t) => {
            const daemon = await flavour.start();
            const bystander = await startReceiver();
            let receiver = null;
            await withDaemon(daemon, async () => {
                await register(flavour, daemon, bystander, 'contract-bystander');
                const [oldDevice, newDevice] = await flavour.replacePair(daemon);
                const version = (await daemon.call('getDeviceDescription', [oldDevice])).VERSION;
                // rfd answers only after it tried to give the new device the AES key (two tries to an absent device)
                const replaced = await daemon.call('replaceDevice', [oldDevice, newDevice], {timeout: 30000});
                t.diagnostic(`replaceDevice answered ${JSON.stringify(replaced)}`);
                assert.equal(replaced, true);
                const after = (await daemon.call('listDevices')).map((d) => d.ADDRESS);
                assert.ok(!after.includes(oldDevice) && after.includes(newDevice), 'the old device is gone');

                receiver = await startReceiver({
                    methods: {
                        'system.listMethods': () => [
                            'system.listMethods',
                            'system.multicall',
                            'listDevices',
                            'newDevices',
                            'deleteDevices',
                            'replaceDevice',
                            'event',
                        ],
                        listDevices: () => [{ADDRESS: oldDevice, VERSION: version}],
                        replaceDevice: () => '',
                    },
                });
                await register(flavour, daemon, receiver, 'contract-replace');
                await sleep(1500);
                const deletes = receiver.calls('deleteDevices').map((c) => c.params[1]);
                t.diagnostic(`deleteDevices to the receiver: ${JSON.stringify(deletes)}`);
                const call = await receiver.waitFor('replaceDevice', 5000);
                assert.deepEqual(call.params, ['contract-replace', oldDevice, newDevice]);
                assert.equal(deletes.length, 0, 'a replaced device is not deleted');
            }).finally(() => stopAll([bystander, receiver].filter(Boolean)));
        },
    );
}
