/**
 * A misbehaving event receiver blocks nothing - or does it. For rfd and hs485d, with callbacks over BIN-RPC and
 * XML-RPC: a raw receiver (test/helpers/raw-receiver.js) closes mid-request, vanishes, never answers or never reads,
 * answers with HTTP errors, faults, garbage, truncated, wrong-typed, huge, trickled or doubled responses; at init it
 * answers listDevices with a huge or invalid list, never answers at all, or never answers newDevices; and a client
 * re-registers in a tight loop, two receivers share an id, a receiver URL leads nowhere.
 *
 * Throughout, a well-behaved receiver must keep getting its events, the daemon must keep answering RPC, the radio side
 * must keep working, and the daemon's fds and threads must come back to where they were. Expectations from the public
 * source (libhsscomm, libXmlRpc):
 *
 * - events: one HSSXmlRpcEventDispatcher thread per receiver, XmlRpcClient timeout 10 000 ms
 *   (`m_pClient->setTimeout(10000)`), each batch tried twice - so a hanging receiver should cost only its own thread;
 * - init: `HSSManager::XmlRpcCallSync()` (system.listMethods, listDevices) on the daemon's main loop: before
 *   OpenCCU-Base #170 with the client's default timeout of -1, i.e. none; with the fix a 30 000 ms timeout
 *   (`c.setTimeout(30000)`), so a receiver that never answers freezes the daemon for at most that long per callback;
 * - newDevices/deleteDevices/replaceDevice: `AsyncXmlRpcSender`, a detached thread per call; no timeout before
 *   OpenCCU-Base #171, 30 000 ms with the fix.
 *
 * Timing assumptions: margins of 3 s for "at once" (the well-behaved receiver normally has its event in ~20 ms),
 * 2 x 10 s + slack for a hanging receiver's dispatcher to give up on a batch, and 30 s + slack for the init callbacks.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {startRfd, startHs485d, withDaemon, skipWithoutDaemons, HS485TYPES} from '../helpers/daemon.js';
import {startReceiver, BinRpcClient} from '../helpers/rpc.js';
import {startRawReceiver} from '../helpers/raw-receiver.js';
import {regression} from '../helpers/known.js';
import {attachSwitch, pairSwitch, waitForEvent, SWITCH_SERIAL} from '../helpers/switch.js';
import {loadDeviceDescription} from '../../lib/rftypes.js';
import {WiredBus, WiredDevice} from '../../lib/wired.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** HSSXmlRpcEventDispatcher's client timeout (libhsscomm), each batch tried twice. */
const DISPATCH_TIMEOUT_MS = 10000;
/**
 * The timeout of the init callbacks (`HSSManager::XmlRpcCallSync`, OpenCCU-Base #170) and of the asynchronous
 * callbacks (`AsyncXmlRpcSender`, OpenCCU-Base #171), both `setTimeout(30000)`.
 */
const CALLBACK_TIMEOUT_MS = 30000;
const AT_ONCE_MS = 3000;

/** The modes that hit event deliveries (see raw-receiver.js). */
const EVENT_MODES = [
    'close',
    'close-partial',
    'vanish',
    'no-answer',
    'no-read',
    'http-500',
    'fault',
    'garbage',
    'truncated',
    'wrong-type',
    'huge',
    'trickle',
    'twice',
];

const FLAVOURS = [
    {
        name: 'rfd',
        initArgs: (url, id) => [url, id],
        /** rfd with a paired switch; `radio(t)` switches it and waits for the STATE event at the good receiver */
        async start(good) {
            const rfd = await startRfd();
            const {air, device} = attachSwitch(rfd);
            await rfd.call('init', [good.url, 'good']);
            await pairSwitch(rfd, good, air, device);
            let state = false;
            rfd.radio = async () => {
                state = !state;
                const from = good.received.length;
                await rfd.call('setValue', [`${SWITCH_SERIAL}:1`, 'STATE', state], {timeout: 10000});
                await waitForEvent(good, `${SWITCH_SERIAL}:1`, 'STATE', state, {from, timeout: 10000});
            };
            return rfd;
        },
    },
    {
        name: 'hs485d',
        initArgs: (url, id) => [url, id, false],
        async start(good) {
            const bus = new WiredBus();
            bus.add(
                new WiredDevice({
                    address: 0x00004711,
                    serial: 'SIMW000001',
                    description: loadDeviceDescription(path.join(HS485TYPES, 'hmw_lc_sw2_dr.xml')),
                    typeId: 'HMW-LC-Sw2-DR',
                    sysinfo: [0x11, 0x00, 0x03, 0x05],
                }),
            );
            const hs485d = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus});
            await hs485d.call('init', [good.url, 'good', false]);
            assert.equal(await hs485d.call('searchDevices', [], {timeout: 60000}), 1);
            let state = false;
            hs485d.radio = async () => {
                state = !state;
                const from = good.received.length;
                await hs485d.call('setValue', ['SIMW000001:3', 'STATE', state], {timeout: 10000});
                await waitForEvent(good, 'SIMW000001:3', 'STATE', state, {from, timeout: 10000});
            };
            return hs485d;
        },
    },
];

function pongs(receiver) {
    return receiver.received.filter((r) => r.method === 'event' && r.params[2] === 'PONG').map((r) => r.params[3]);
}

/** fds and threads of the daemon process. */
function resources(daemon) {
    return {
        fds: fs.readdirSync(`/proc/${daemon.pid}/fd`).length,
        threads: fs.readdirSync(`/proc/${daemon.pid}/task`).length,
    };
}

/**
 * One event (a ping) and the checks that nothing is blocked: the good receiver has its PONG within AT_ONCE_MS, and
 * another RPC client gets listDevices answered within AT_ONCE_MS. Returns the two latencies.
 */
async function eventGetsThrough(daemon, good, probe, value) {
    const at = Date.now();
    await probe.call('ping', [value], {timeout: AT_ONCE_MS});
    const until = at + AT_ONCE_MS;
    while (!pongs(good).includes(value)) {
        if (Date.now() > until) {
            throw new Error(`the good receiver did not get PONG ${value} within ${AT_ONCE_MS} ms`);
        }
        await sleep(10);
    }
    const pong = Date.now() - at;
    const rpcAt = Date.now();
    await probe.call('listDevices', [], {timeout: AT_ONCE_MS});
    return {pong, rpc: Date.now() - rpcAt};
}

/** Waits until the raw receiver has seen a request matching `pred` (its dispatcher got through). */
async function waitForRequest(raw, pred, timeout) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (raw.requests.some(pred)) {
            return true;
        }
        await sleep(50);
    }
    return false;
}

for (const flavour of FLAVOURS) {
    for (const proto of ['binrpc', 'xmlrpc']) {
        test(
            `${flavour.name}, ${proto} callbacks: a receiver that misbehaves on events (${EVENT_MODES.join(', ')}) holds up no other receiver, no RPC, no radio, and leaks nothing`,
            {...skipWithoutDaemons, timeout: 900000},
            async (t) => {
                const good = await startReceiver();
                const bad = await startRawReceiver({protocol: proto});
                const daemon = await flavour.start(good);
                const probe = new BinRpcClient(daemon.port);
                const latencies = [];
                await withDaemon(daemon, async () => {
                    await daemon.call('init', flavour.initArgs(bad.url, 'bad'), {timeout: 30000});
                    let n = 0;
                    // warm up: both receivers in sync, the dispatcher threads exist
                    for (let i = 0; i < 3; i++) {
                        await eventGetsThrough(daemon, good, probe, `warm-${n++}`);
                    }
                    assert.ok(
                        await waitForRequest(bad, (r) => r.method === 'system.multicall', 5000),
                        'bad got events',
                    );
                    await sleep(500);
                    const before = resources(daemon);
                    for (const mode of EVENT_MODES) {
                        bad.misbehave(mode);
                        const from = bad.requests.length;
                        for (let i = 0; i < 3; i++) {
                            const l = await eventGetsThrough(daemon, good, probe, `${mode}-${n++}`);
                            latencies.push(l.pong, l.rpc);
                            await sleep(200);
                        }
                        const hit = bad.requests.slice(from).filter((r) => r.mode === mode).length;
                        // back to good behaviour, and one event the bad receiver takes: its failure count starts over
                        // (ten in a row would remove it - and under ASan the removal is the double-join finding)
                        if (mode === 'vanish') {
                            await bad.start(bad.port);
                        }
                        bad.misbehave('ok');
                        const okFrom = bad.requests.length;
                        await eventGetsThrough(daemon, good, probe, `${mode}-ok-${n++}`);
                        const back = await waitForRequest(
                            bad,
                            (r) =>
                                r.mode === 'ok' && r.method === 'system.multicall' && bad.requests.indexOf(r) >= okFrom,
                            2 * DISPATCH_TIMEOUT_MS + 5000,
                        );
                        t.diagnostic(`${mode}: ${hit} misbehaved deliveries; back in sync: ${back}`);
                        assert.ok(daemon.alive, `${flavour.name} died on ${mode}: ${JSON.stringify(daemon.exit)}`);
                    }
                    await daemon.radio();
                    // let every dispatcher settle, then compare
                    await sleep(2000);
                    const after = resources(daemon);
                    t.diagnostic(
                        `fds ${before.fds} -> ${after.fds}, threads ${before.threads} -> ${after.threads}; worst latency ${Math.max(...latencies)} ms`,
                    );
                    assert.ok(after.threads <= before.threads + 1, `threads ${before.threads} -> ${after.threads}`);
                    assert.ok(after.fds <= before.fds + 3, `fds ${before.fds} -> ${after.fds}`);
                    assert.deepEqual(daemon.sanitizerReports(), []);
                }).finally(async () => {
                    probe.client.close();
                    await good.stop();
                    await bad.stop();
                });
            },
        );
    }

    test(
        `${flavour.name}: init with a receiver that answers listDevices with a huge or an invalid list - the daemon survives and answers`,
        {...skipWithoutDaemons, timeout: 300000},
        async (t) => {
            const good = await startReceiver();
            const daemon = await flavour.start(good);
            const probe = new BinRpcClient(daemon.port);
            const lists = {
                huge: () =>
                    Array.from({length: 20000}, (_, i) => ({
                        ADDRESS: `GHOST${String(i).padStart(5, '0')}`,
                        VERSION: 1,
                    })),
                'a string': () => 'not a list',
                numbers: () => [1, 2, 3],
                'structs without ADDRESS': () => [{VERSION: 1}, {FOO: 'bar'}],
                'ADDRESS of the wrong type': () => [{ADDRESS: 42, VERSION: 'x'}],
            };
            const bads = [];
            await withDaemon(daemon, async () => {
                for (const [name, list] of Object.entries(lists)) {
                    const bad = await startRawReceiver({listDevices: list});
                    bads.push(bad);
                    const at = Date.now();
                    const outcome = await daemon
                        .call('init', flavour.initArgs(bad.url, `list-${name}`), {timeout: 60000})
                        .then(
                            (r) => `answered ${JSON.stringify(r)}`,
                            (e) => `error ${e.faultString || e.message}`,
                        );
                    t.diagnostic(
                        `listDevices ${name}: init ${outcome} after ${Date.now() - at} ms; bad got ${bad.requests.map((r) => r.method).join(' ')}`,
                    );
                    assert.ok(
                        daemon.alive,
                        `${flavour.name} died on listDevices ${name}: ${JSON.stringify(daemon.exit)}`,
                    );
                    await eventGetsThrough(daemon, good, probe, `list-${name}`);
                }
                await daemon.radio();
                assert.deepEqual(daemon.sanitizerReports(), []);
            }).finally(async () => {
                probe.client.close();
                await good.stop();
                for (const b of bads) {
                    await b.stop();
                }
            });
        },
    );

    test(
        `${flavour.name}: init with a receiver that never answers stalls the daemon at most for the callback timeout, then it recovers by itself (the init-blocks finding, #170)`,
        {...skipWithoutDaemons, ...regression('init-blocks'), timeout: 300000},
        async (t) => {
            // HSSManager::PlatformInit -> XmlRpcCallSync("system.listMethods") on the main loop: without a timeout the
            // daemon stands still until the receiver closes; with OpenCCU-Base #170 it answers again after
            // CALLBACK_TIMEOUT_MS, the receiver still connected (listDevices, which the receiver answers, follows)
            const good = await startReceiver();
            const daemon = await flavour.start(good);
            const probe = new BinRpcClient(daemon.port);
            const bad = await startRawReceiver();
            bad.misbehave('no-answer', {on: ['system.listMethods']});
            const initClient = new BinRpcClient(daemon.port);
            await withDaemon(daemon, async () => {
                const pending = initClient
                    .call('init', flavour.initArgs(bad.url, 'silent'), {timeout: 2 * CALLBACK_TIMEOUT_MS + AT_ONCE_MS})
                    .then(
                        () => 'answered',
                        (e) => `failed: ${e.message}`,
                    );
                assert.ok(
                    await waitForRequest(bad, (r) => r.method === 'system.listMethods', 5000),
                    'the receiver got system.listMethods',
                );
                const stalledAt = Date.now();
                // probe with a fresh client each time: a call the daemon answers late must not confuse the next one
                let unanswered = 0;
                let recoveredAfter = null;
                while (recoveredAfter === null && Date.now() - stalledAt < CALLBACK_TIMEOUT_MS + 2 * AT_ONCE_MS) {
                    const client = new BinRpcClient(daemon.port);
                    try {
                        await client.call('listDevices', [], {timeout: AT_ONCE_MS});
                        recoveredAfter = Date.now() - stalledAt;
                    } catch {
                        unanswered++;
                    } finally {
                        client.client.close();
                    }
                }
                t.diagnostic(
                    `while the receiver keeps init waiting: ${unanswered} probes of ${AT_ONCE_MS} ms unanswered; RPC answered again after ${recoveredAfter} ms (bound ${CALLBACK_TIMEOUT_MS} ms)`,
                );
                assert.notEqual(
                    recoveredAfter,
                    null,
                    `RPC stalled for more than ${CALLBACK_TIMEOUT_MS} ms while init waited for the receiver`,
                );
                const outcome = await pending;
                t.diagnostic(`init ${outcome}`);
                assert.equal(outcome, 'answered');
                assert.ok(daemon.alive);
                await eventGetsThrough(daemon, good, probe, 'after-recovery');
            }).finally(async () => {
                probe.client.close();
                initClient.client.close();
                await good.stop();
                await bad.stop();
            });
        },
    );

    test(
        `${flavour.name}: a receiver that never answers newDevices leaves no thread behind per init (the async-callback-threads finding, #171)`,
        {...skipWithoutDaemons, ...regression('async-callback-threads'), timeout: 300000},
        async (t) => {
            // newDevices goes through AsyncXmlRpcSender: a detached thread per call, with no client timeout before
            // OpenCCU-Base #171 and CALLBACK_TIMEOUT_MS since - after that the threads must be gone
            const good = await startReceiver();
            const daemon = await flavour.start(good);
            const bad = await startRawReceiver();
            bad.misbehave('no-answer', {on: ['newDevices']});
            await withDaemon(daemon, async () => {
                const before = resources(daemon);
                const rounds = 10;
                for (let i = 0; i < rounds; i++) {
                    await daemon.call('init', flavour.initArgs(bad.url, `async-${i}`), {timeout: 30000});
                }
                await waitForRequest(
                    bad,
                    (r) => r.method === 'newDevices' && bad.calls('newDevices').length >= rounds,
                    10000,
                );
                await sleep(CALLBACK_TIMEOUT_MS + 2 * AT_ONCE_MS);
                const after = resources(daemon);
                t.diagnostic(
                    `${bad.calls('newDevices').length} unanswered newDevices: threads ${before.threads} -> ${after.threads}, fds ${before.fds} -> ${after.fds}`,
                );
                assert.ok(daemon.alive);
                assert.ok(
                    after.threads < before.threads + rounds,
                    `one thread left per unanswered newDevices: ${before.threads} -> ${after.threads}`,
                );
            }).finally(async () => {
                await good.stop();
                await bad.stop();
            });
        },
    );

    test(
        `${flavour.name}: a client re-registering in a tight loop, two receivers with one id, a receiver URL that leads nowhere`,
        {...skipWithoutDaemons, timeout: 300000},
        async (t) => {
            const good = await startReceiver();
            const daemon = await flavour.start(good);
            const probe = new BinRpcClient(daemon.port);
            const twin = await startReceiver();
            await withDaemon(daemon, async () => {
                const before = resources(daemon);
                for (let i = 0; i < 100; i++) {
                    await daemon.call('init', flavour.initArgs(good.url, 'good'), {timeout: 30000});
                }
                await sleep(1000);
                const after = resources(daemon);
                t.diagnostic(
                    `100 re-registrations: threads ${before.threads} -> ${after.threads}, fds ${before.fds} -> ${after.fds}`,
                );
                assert.ok(after.threads <= before.threads + 2, `threads ${before.threads} -> ${after.threads}`);
                assert.ok(after.fds <= before.fds + 4, `fds ${before.fds} -> ${after.fds}`);
                await eventGetsThrough(daemon, good, probe, 'after-loop');

                // a second receiver under the same id: both are separate handlers (by url) and both get events
                await daemon.call('init', flavour.initArgs(twin.url, 'good'), {timeout: 30000});
                await probe.call('ping', ['twins']);
                await sleep(1000);
                t.diagnostic(
                    `same id: good got ${pongs(good).includes('twins')}, twin got ${pongs(twin).includes('twins')}`,
                );
                assert.ok(pongs(good).includes('twins') && pongs(twin).includes('twins'));

                // a url nobody can connect to: a refused port answers at once; the init must not hang on it
                const at = Date.now();
                const refused = await daemon
                    .call('init', flavour.initArgs('xmlrpc_bin://127.0.0.1:1', 'nowhere'), {timeout: 30000})
                    .then(
                        () => 'answered',
                        (e) => `error ${e.message}`,
                    );
                t.diagnostic(`init to a refused port: ${refused} after ${Date.now() - at} ms`);
                await eventGetsThrough(daemon, good, probe, 'after-refused');
                await daemon.radio();
                assert.deepEqual(daemon.sanitizerReports(), []);
            }).finally(async () => {
                probe.client.close();
                await good.stop();
                await twin.stop();
            });
        },
    );
}
