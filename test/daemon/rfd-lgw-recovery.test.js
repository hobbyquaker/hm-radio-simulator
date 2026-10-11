/**
 * rfd's LAN-gateway recovery beyond the reconnects of rfd-lgw-front.test.js: what OpenCCU-Base #13 (LAN gateway
 * reconnect recovery), #17 (configured serial vs. reported serial), 6c757603 (message framing on 64-bit) and e097a3c1
 * (`select()` -> `poll()` for the gateway socket) changed and nothing else here reaches.
 *
 * #13: a coprocessor restore that fails is retried and ends in a new TCP connection instead of an ACTIVE interface;
 * a coprocessor that does not answer after the TCP reconnect is not counted as recovered; no telegram is sent while
 * the interface re-initialises; the bidcos-channel keepalive thread is joined on a reconnect (before, a typo cleared
 * the thread handle instead of the run flag, so every reconnect left one thread running); the remote interface's
 * init fails when `SET_CLOCK` fails. #17: a hello without a serial is rejected when a serial is configured; the
 * status file, the keepalive port and the reconnect search use the configured serial.
 *
 * Timing assumptions (rfd main, LGWPortWrapper.cpp / CCU2CommController.cpp): after a failed re-initialisation rfd
 * disconnects and retries after `basetimeout` = 5 s; a restore after a module restart is tried 3 times, 1 s apart;
 * rfd's coprocessor command window `coproCommandTimeout` is 1000 ms; improvedInit() waits 20 x 250 ms for the
 * application. Waits here have margins of several seconds. Ports 2000/2001 are fixed in rfd, so the tests run one
 * after another.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {startRfd, spawnRfd, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {regression} from '../helpers/known.js';
import {startReceiver} from '../helpers/rpc.js';
import {attachSwitch, pairSwitch, waitForEvent, SWITCH_ADDRESS} from '../helpers/switch.js';
import {createEq3LanDevice} from '../../lib/eq3udp.js';
import {SYSTEM_STATUS} from '../../lib/commands.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 240000, ...extra});
const SERIAL = 'SIM0000002';
const KEY = 'TestLanKey-1234';

async function waitUntil(predicate, timeoutMs, what) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (await predicate()) {
            return Date.now();
        }
        await sleep(250);
    }
    throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`);
}

async function connected(rfd) {
    const interfaces = await rfd.call('listBidcosInterfaces', [], {timeout: 5000});
    return interfaces.length === 1 && interfaces[0].CONNECTED === true;
}

/** rfd with the AES gateway, a receiver and a paired switch, so a restore has a device to republish. */
async function rfdWithSwitch(lgwFront = {serial: SERIAL, key: KEY}) {
    const rfd = await startRfd({lgwFront});
    const receiver = await startReceiver();
    const {air, device} = attachSwitch(rfd);
    await rfd.call('init', [receiver.url, 'hmrs']);
    await receiver.waitFor('newDevices', 15000);
    await pairSwitch(rfd, receiver, air, device);
    return {rfd, receiver, air, device};
}

/** The module's commands from index `from` on, by name. */
const commandsFrom = (module, from) => module.commands.slice(from).map((c) => c.name);

/**
 * Drops port 2000 with a fault set on the module's answers during the re-initialisation, and waits until rfd is back.
 * @returns {Promise<{clients: number, ms: number, from: number}>} the new BidCoS connections, the time, the index of
 *   the first module command after the drop
 */
async function reconnectThrough(rfd, name, fault) {
    const {lgw, module} = rfd;
    const clientsBefore = lgw.clientsSeen.bidcos;
    const from = module.commands.length;
    const reconnectedBefore = rfd.grep(/Reconnected\./).length;
    module.inject(name, fault);
    const at = Date.now();
    lgw.drop('bidcos');
    await waitUntil(() => rfd.grep(/Reconnected\./).length > reconnectedBefore, 60000, 'the Reconnected log line');
    await waitUntil(() => connected(rfd), 15000, 'CONNECTED after the reconnect');
    return {clients: lgw.clientsSeen.bidcos - clientsBefore, ms: Date.now() - at, from};
}

test(
    'AES: the restore after a reconnect fails twice (SET_CLOCK answered with an error) - rfd drops the connection, retries after 5 s and is back only with a complete restore (#13)',
    options(),
    async (t) => {
        const {rfd, receiver, device} = await rfdWithSwitch();
        await withDaemon(rfd, async () => {
            const {module} = rfd;
            const {clients, ms, from} = await reconnectThrough(rfd, 'SET_CLOCK', {
                status: SYSTEM_STATUS.ERROR,
                times: 2,
            });
            const names = commandsFrom(module, from);
            t.diagnostic(`back after ${ms} ms, ${clients} BidCoS connections; the module saw: ${names.join(' ')}`);
            await t.test('a failed restore is not taken as recovered', regression(13), () => {
                assert.ok(rfd.grep(/Coprocessor reinitialization failed/).length >= 2, rfd.tail(30));
                assert.ok(rfd.grep(/Coprocessor not ready\. Retrying in 5 seconds/).length >= 2);
                assert.ok(clients >= 3, `a new TCP connection after each failed restore: ${clients}`);
                assert.ok(ms >= 9000, `two retries 5 s apart: ${ms} ms`);
            });
            await t.test('the last restore is complete: key, device, clock', () => {
                const last = names.lastIndexOf('IDENTIFY');
                const restore = names.slice(last);
                for (const name of ['SET_CURRENT_AES_KEY', 'ADD_LINK_PEER', 'SET_CLOCK']) {
                    assert.ok(restore.includes(name), `${name} in ${restore.join(' ')}`);
                }
                assert.ok(module.peers.has(SWITCH_ADDRESS));
            });
            await rfd.call('setValue', [`${device.serial}:1`, 'STATE', true]);
            await waitForEvent(receiver, `${device.serial}:1`, 'STATE', true);
            assert.ok(rfd.alive);
        }).finally(() => receiver.stop());
    },
);

test(
    'AES: the coprocessor does not answer after the TCP reconnect (IDENTIFY dropped twice) - rfd sends no telegram meanwhile and retries until it answers (#13)',
    options(),
    async (t) => {
        const {rfd, receiver, device} = await rfdWithSwitch();
        await withDaemon(rfd, async () => {
            const {lgw, module} = rfd;
            const clientsBefore = lgw.clientsSeen.bidcos;
            const reconnected = rfd.grep(/Reconnected\./).length;
            const identifies = module.commands.filter((c) => c.name === 'IDENTIFY').length;
            const from = module.commands.length;
            module.inject('IDENTIFY', {drop: true, times: 2});
            const at = Date.now();
            lgw.drop('bidcos');
            // the TCP connection is back and rfd waits for the coprocessor (improvedInit: 1 s for the answer, then
            // 20 x 250 ms for the application) - the interface re-initialises, the transport is open: sets now
            await module.waitForCommand('IDENTIFY', {count: identifies + 1, timeout: 30000});
            const sets = [];
            let value = false;
            for (let i = 0; i < 12; i++) {
                value = !value;
                sets.push(
                    rfd.call('setValue', [`${device.serial}:1`, 'STATE', value], {timeout: 30000}).then(
                        () => 'answered',
                        (error) => `fault: ${String(error.message).slice(0, 60)}`,
                    ),
                );
                await sleep(300);
            }
            await waitUntil(() => rfd.grep(/Reconnected\./).length > reconnected, 60000, 'the Reconnected log line');
            await waitUntil(() => connected(rfd), 15000, 'CONNECTED after the reconnect');
            const outcomes = await Promise.all(sets);
            const names = commandsFrom(module, from);
            const clients = lgw.clientsSeen.bidcos - clientsBefore;
            const restored = names.indexOf('SET_CLOCK');
            t.diagnostic(`back after ${Date.now() - at} ms, ${clients} BidCoS connections`);
            t.diagnostic(
                `${sets.length} sets meanwhile: ${[...new Set(outcomes)].join(', ')}; the module saw: ${names.join(' ')}`,
            );
            await t.test('a TCP connection without a coprocessor is not taken as recovered', regression(13), () => {
                assert.ok(rfd.grep(/Coprocessor not ready\. Retrying in 5 seconds/).length >= 2, rfd.tail(30));
                assert.ok(clients >= 3, `a new TCP connection after each silent IDENTIFY: ${clients}`);
                assert.ok(names.filter((n) => n === 'IDENTIFY').length >= 3);
            });
            await t.test('no SEND_TELEGRAM before the restore has finished', regression(13), () => {
                assert.ok(restored > 0, 'the restore reached SET_CLOCK');
                assert.ok(!names.slice(0, restored).includes('SEND_TELEGRAM'), names.join(' '));
            });
            const fromEvents = receiver.received.length;
            await rfd.call('setValue', [`${device.serial}:1`, 'STATE', !value]);
            await waitForEvent(receiver, `${device.serial}:1`, 'STATE', !value, {from: fromEvents});
            assert.ok(rfd.alive);
        }).finally(() => receiver.stop());
    },
);

test(
    'AES: the module restarts behind the gateway and the restore fails 3 times - rfd retries 1 s apart, then schedules a gateway reconnect (#13)',
    options(),
    async (t) => {
        const rfd = await startRfd({lgwFront: {serial: SERIAL, key: KEY}});
        await withDaemon(rfd, async () => {
            const {lgw, module} = rfd;
            const clientsBefore = lgw.clientsSeen.bidcos;
            const reconnectedBefore = rfd.grep(/Reconnected\./).length;
            module.inject('SET_CLOCK', {status: SYSTEM_STATUS.ERROR, times: 3});
            // a module restart: it enters the bootloader and announces it; rfd starts the application and restores
            module.switchMode('bootloader');
            await waitUntil(
                () => rfd.grep(/Scheduling LAN gateway reconnect/).length >= 1,
                30000,
                'the scheduled gateway reconnect',
            ).catch(() => {});
            await t.test('3 restore attempts, then a new gateway connection', regression(13), async () => {
                assert.equal(
                    rfd.grep(/Restoring coprocessor configuration failed\. Retrying\./).length,
                    2,
                    rfd.tail(30),
                );
                assert.equal(rfd.grep(/Scheduling LAN gateway reconnect/).length, 1);
                await waitUntil(() => rfd.grep(/Reconnected\./).length > reconnectedBefore, 60000, 'Reconnected');
                assert.ok(lgw.clientsSeen.bidcos > clientsBefore);
            });
            await waitUntil(() => connected(rfd), 30000, 'CONNECTED');
            assert.ok(rfd.alive);
        });
    },
);

test(
    'AES: three reconnects leave no bidcos-channel keepalive thread behind - the thread count is back where it was (#13)',
    options(),
    async (t) => {
        const rfd = await startRfd({lgwFront: {serial: SERIAL, key: KEY}});
        await withDaemon(rfd, async () => {
            const {lgw} = rfd;
            await sleep(3000);
            const before = rfd.threads();
            for (let i = 0; i < 3; i++) {
                const reconnected = rfd.grep(/Reconnected\./).length;
                lgw.drop('bidcos');
                await waitUntil(() => rfd.grep(/Reconnected\./).length > reconnected, 60000, `reconnect ${i + 1}`);
            }
            await waitUntil(() => connected(rfd), 15000, 'CONNECTED');
            // the reconnect threads are detached and end on their own; give them a moment
            let after = rfd.threads();
            await waitUntil(() => (after = rfd.threads()) <= before, 10000, 'the thread count back at its level').catch(
                () => {},
            );
            t.diagnostic(`threads before: ${before}, after three reconnects: ${after}`);
            await t.test('no leaked thread', regression(13), () => {
                assert.ok(after <= before, `${after - before} more threads after three reconnects`);
            });
        });
    },
);

test(
    'AES: SET_CLOCK fails during the start - the interface does not come up as connected (#13)',
    options(),
    async (t) => {
        const rfd = await spawnRfd({
            lgwFront: {serial: SERIAL, key: KEY},
            module: {faults: {SET_CLOCK: {status: SYSTEM_STATUS.ERROR, times: 1000}}},
        });
        try {
            const outcome = await Promise.race([
                rfd.waitReady().then(
                    () => 'ready',
                    () => 'not ready',
                ),
                rfd.exited.then(() => 'exited'),
            ]);
            await sleep(3000);
            let interfaces = null;
            if (rfd.alive) {
                interfaces = await rfd.call('listBidcosInterfaces', [], {timeout: 5000}).catch((e) => e.message);
            }
            const names = rfd.module.commands.map((c) => c.name);
            t.diagnostic(
                `rfd: ${outcome}, ${rfd.alive ? 'alive' : JSON.stringify(rfd.exit)}; interfaces ${JSON.stringify(interfaces)}`,
            );
            t.diagnostic(`the module saw: ${names.join(' ')}`);
            assert.ok(names.includes('SET_CLOCK'), 'rfd set the clock');
            await t.test('no connected interface after a failed SET_CLOCK', regression(13), () => {
                const up = Array.isArray(interfaces) && interfaces.some((i) => i.CONNECTED === true);
                assert.ok(!up, `listBidcosInterfaces: ${JSON.stringify(interfaces)}`);
            });
        } finally {
            await rfd.stop();
        }
    },
);

test('a hello without a serial is rejected - rfd.conf names the serial (#17)', options(), async (t) => {
    // libUnifiedLanComm accepts a hello without a serial when no serial is wanted, but rfd cannot run an HMLGW2
    // interface without `Serial Number` (BidcosInterface::Init gives up: "No BidCoS-Interface available"), so
    // only the rejection is reachable through rfd
    const rejected = await spawnRfd({lgwFront: {serial: SERIAL, key: KEY}});
    rejected.lgw.serialByPort = {bidcos: false, keepalive: false};
    try {
        await waitUntil(
            () => rejected.grep(/HELLO message does not contain a serial number/).length >= 1 || !rejected.alive,
            30000,
            'the rejection',
        ).catch(() => {});
        const relayed = rejected.lgw.trace.filter((e) => e.dir === 'rx' && e.line && e.line.startsWith('>'));
        t.diagnostic(
            `configured serial: ${rejected.grep(/HELLO message/).length} rejections, ${relayed.length} switch answers`,
        );
        await t.test('rejected with a configured serial', regression(17), () => {
            assert.ok(rejected.grep(/HELLO message does not contain a serial number/).length >= 1, rejected.tail(30));
            assert.equal(relayed.length, 0, 'rfd answered the switch command of a gateway without serial');
        });
    } finally {
        await rejected.stop();
    }
});

test(
    'the status file is named after the configured serial, not the spelling the gateway reports (#17)',
    options(),
    async (t) => {
        const statusDir = '/var/status';
        try {
            fs.mkdirSync(statusDir, {recursive: true});
            fs.accessSync(statusDir, fs.constants.W_OK);
        } catch {
            t.skip(`${statusDir} is not writable here (rfd writes it as a fixed path; the image runs as root)`);
            return;
        }
        const configured = 'sim0000017';
        const reported = 'SIM0000017';
        const file = (serial) => `${statusDir}/${serial}.connstat`;
        for (const serial of [configured, reported]) {
            fs.rmSync(file(serial), {force: true});
        }
        const rfd = await startRfd({lgwFront: {serial: reported, key: KEY, configuredSerial: configured}});
        await withDaemon(rfd, async () => {
            assert.ok(await connected(rfd));
            assert.ok(fs.existsSync(file(configured)), `${file(configured)} after the start`);
            const first = fs.statSync(file(configured)).mtimeMs;
            const reconnected = rfd.grep(/Reconnected\./).length;
            await sleep(1100);
            rfd.lgw.drop('bidcos');
            await waitUntil(() => rfd.grep(/Reconnected\./).length > reconnected, 60000, 'the reconnect');
            const second = fs.statSync(file(configured)).mtimeMs;
            t.diagnostic(
                `${file(configured)}: ${JSON.stringify(fs.readFileSync(file(configured), 'utf8'))}, rewritten ${second > first}; ${file(reported)}: ${fs.existsSync(file(reported))}`,
            );
            await t.test('one file, under the configured serial, rewritten on the reconnect', regression(17), () => {
                assert.ok(second > first, 'rewritten on the disconnect and the reconnect');
                assert.ok(!fs.existsSync(file(reported)), `no ${file(reported)}`);
            });
        });
        for (const serial of [configured, reported]) {
            fs.rmSync(file(serial), {force: true});
        }
    },
);

test(
    'AES: port 2001 names another gateway than port 2000 - rfd rejects the keepalive connection until it matches (#17)',
    options(),
    async (t) => {
        const rfd = await startRfd({lgwFront: {serial: SERIAL, key: KEY}});
        await withDaemon(rfd, async () => {
            const {lgw} = rfd;
            assert.ok(await connected(rfd));
            let keepaliveUp = 0;
            const onConnected = (kind) => {
                if (kind === 'keepalive') {
                    keepaliveUp++;
                }
            };
            lgw.on('connected', onConnected);
            lgw.serialByPort = {keepalive: 'OTHER00001'};
            const seenBefore = lgw.clientsSeen.keepalive;
            lgw.drop('keepalive');
            await waitUntil(
                () => rfd.grep(/does not match reported serial OTHER00001/).length >= 1,
                30000,
                'the rejected keepalive hello',
            ).catch(() => {});
            await sleep(3000);
            t.diagnostic(
                `keepalive clients while port 2001 says OTHER00001: ${lgw.clientsSeen.keepalive - seenBefore}, through to the relay: ${keepaliveUp}`,
            );
            await t.test('the keepalive port checks the serial', regression(17), () => {
                assert.ok(rfd.grep(/does not match reported serial OTHER00001/).length >= 1, rfd.tail(30));
                assert.equal(keepaliveUp, 0, 'a keepalive connection to the other gateway went through');
            });
            lgw.serialByPort = {};
            await waitUntil(() => keepaliveUp >= 1, 60000, 'the keepalive connection with the right serial');
            await waitUntil(() => connected(rfd), 30000, 'CONNECTED');
            lgw.off('connected', onConnected);
            assert.ok(rfd.alive);
        });
    },
);

test(
    'search by serial: after a drop rfd looks for the configured serial, not the reported spelling (#17)',
    options(),
    async (t) => {
        const configured = 'sim0000002';
        const lanDevice = await createEq3LanDevice({
            type: 'eQ3-HM-LGW',
            serial: SERIAL,
            ip: '127.0.0.1',
            services: [[1, 2000]],
            serialIgnoringCase: true,
        });
        try {
            const rfd = await startRfd({
                lgwFront: {serial: SERIAL, key: KEY, search: true, configuredSerial: configured},
            });
            await withDaemon(rfd, async () => {
                assert.ok(await connected(rfd));
                const from = lanDevice.requests.length;
                const reconnected = rfd.grep(/Reconnected\./).length;
                rfd.lgw.drop('bidcos');
                await waitUntil(() => rfd.grep(/Reconnected\./).length > reconnected, 60000, 'the reconnect');
                // the identify broadcast names the wanted serial; the runtime-IP request that follows names the serial
                // the device answered with, so only the identify requests say what rfd looks for
                const requests = lanDevice.requests.slice(from).filter((r) => r.opcode === 'I');
                t.diagnostic(
                    `UDP requests after the drop: ${requests.map((r) => `${r.opcode} ${r.serial}`).join(', ')}`,
                );
                await t.test('the reconnect searches for the configured serial', regression(17), () => {
                    assert.ok(requests.length >= 1, 'an identify request after the drop');
                    assert.ok(
                        requests.every((r) => r.serial === '' || r.serial === configured),
                        requests.map((r) => r.serial).join(', '),
                    );
                });
                assert.ok(await connected(rfd));
            });
        } finally {
            await lanDevice.close();
        }
    },
);

for (const key of [KEY, '']) {
    test(
        `${key ? 'AES' : 'plaintext'}: the gateway's messages split across TCP segments and gathered into one - the init, the keepalives and a switch work (6c757603)`,
        options(),
        async (t) => {
            const lgwFront = {serial: SERIAL, key, segmentation: {pieces: 3, gapMs: 50, coalesce: true}};
            const {rfd, receiver, device} = await rfdWithSwitch(lgwFront);
            await withDaemon(rfd, async () => {
                const {lgw, module} = rfd;
                assert.ok(await connected(rfd));
                await sleep(3500);
                assert.ok(lgw.keepalives >= 2, `keepalives: ${lgw.keepalives}`);
                assert.equal(rfd.grep(/Did not receive reply on keepalive/).length, 0);
                await rfd.call('setValue', [`${device.serial}:1`, 'STATE', true]);
                await waitForEvent(receiver, `${device.serial}:1`, 'STATE', true);
                // and the preamble once more, split, after a reconnect
                const reconnected = rfd.grep(/Reconnected\./).length;
                lgw.drop('bidcos');
                await waitUntil(() => rfd.grep(/Reconnected\./).length > reconnected, 60000, 'the reconnect');
                t.diagnostic(`${lgw.segments} segments written; crc errors ${module.stats.crcErrors}`);
                assert.ok(lgw.segments > 50);
                assert.equal(module.stats.crcErrors, 0);
                assert.ok(rfd.alive);
            }).finally(() => receiver.stop());
        },
    );
}

for (const floor of [900, 1100]) {
    const above = floor > 1024;
    test(
        `AES: rfd started with ${floor} descriptors open - its sockets get numbers ${above ? 'above' : 'below'} 1024; the gateway path (e097a3c1) and the RPC server work`,
        options(),
        async (t) => {
            const rfd = await spawnRfd({lgwFront: {serial: SERIAL, key: KEY}, fdFloor: floor});
            try {
                const {lgw, module} = rfd;
                const both = await waitUntil(
                    () => lgw.connections.bidcos?.state === 'relay' && lgw.connections.keepalive?.state === 'relay',
                    30000,
                    'both gateway ports through the preamble',
                ).then(
                    () => true,
                    () => false,
                );
                await module.waitForCommand('SET_RF_ADDRESS', {timeout: 20000}).catch(() => {});
                // descriptors 1 and 2 are the test's pipes (socket pairs); rfd's own start at the floor
                const sockets = rfd.alive ? rfd.socketFds().filter((fd) => fd > 2) : [];
                t.diagnostic(
                    `rfd ${rfd.alive ? 'alive' : JSON.stringify(rfd.exit)}; socket descriptors ${sockets.join(',')}`,
                );
                await t.test('the gateway path', () => {
                    assert.ok(rfd.alive, `rfd exited: ${JSON.stringify(rfd.exit)}\n${rfd.tail(20)}`);
                    assert.ok(sockets.length >= 3 && sockets.every((fd) => fd >= floor), sockets.join(','));
                    assert.ok(both, 'both ports connected');
                    assert.ok(
                        module.commands.some((c) => c.name === 'SET_RF_ADDRESS'),
                        'the module was initialised',
                    );
                });
                const ready = rfd.alive
                    ? await rfd.waitReady(20000).then(
                          () => true,
                          (e) => e.message.split('\n')[0],
                      )
                    : 'rfd is gone';
                t.diagnostic(`RPC: ${ready}`);
                // libXmlRpc's XmlRpcDispatch::work() still builds fd_sets for select(): a descriptor of 1024 or more
                // is outside the set (FD_SET writes past it), the server socket is never seen readable
                await t.test('the RPC server answers', above ? regression('xmlrpc-select-fd') : {}, () => {
                    assert.equal(ready, true);
                });
                const reports = rfd.sanitizerReports();
                await t.test('no sanitizer report', above ? regression('xmlrpc-select-fd') : {}, () => {
                    assert.equal(reports.length, 0, reports.map((r) => r.text.slice(0, 2000)).join('\n'));
                });
            } finally {
                await rfd.stop();
            }
        },
    );
}

test(
    'two coprocessor system commands at once: each gets its own answer (a duty-cycle query while the module restarts)',
    options(),
    async (t) => {
        const rfd = await startRfd({lgwFront: {serial: SERIAL, key: KEY}});
        await withDaemon(rfd, async () => {
            const {module} = rfd;
            const from = module.commands.length;
            const errorsBefore = rfd.grep(/<(Error|Warning)>.*(getDutyCycle|startCoprocessorAppThreadFunction)/).length;
            // listBidcosInterfaces asks the module for its duty cycle (RFManager -> GetDutyCycle -> GETDUTYCYCLE) in
            // the RPC thread; the answer comes after 900 ms, inside rfd's 1000 ms window. Meanwhile the module
            // announces a restart (bootloader): rfd's start-application thread sends STARTBOOTLOADER 500 ms later,
            // answered at once - two system commands from two threads overlap
            module.dutyCycle = 23;
            module.inject('GETDUTYCYCLE', {delayMs: 900});
            const pending = rfd.call('listBidcosInterfaces', [], {timeout: 10000}).then(
                (value) => ({value}),
                (error) => ({error: error.message}),
            );
            await module.waitForCommand('GETDUTYCYCLE', {count: 1, timeout: 10000});
            module.mode = 'bootloader';
            module.sendIdentifyEvent(0);
            const result = await pending;
            await waitUntil(() => connected(rfd), 30000, 'CONNECTED after the module restart').catch(() => {});
            await sleep(2000);
            const errors = rfd
                .grep(/<(Error|Warning)>.*(getDutyCycle|startCoprocessorAppThreadFunction)/)
                .slice(errorsBefore);
            const names = commandsFrom(module, from);
            const dutyCycle = result.value ? result.value[0].DUTY_CYCLE : null;
            t.diagnostic(
                `listBidcosInterfaces: DUTY_CYCLE ${dutyCycle} ${result.error || ''}; rfd: ${errors.join(' | ') || 'no error'}`,
            );
            t.diagnostic(`the module saw: ${names.join(' ')}`);
            assert.ok(names.indexOf('STARTBOOTLOADER') > names.indexOf('GETDUTYCYCLE'), 'the two commands overlapped');
            // CCU2CommController::sendSystemCommand keeps one request slot (systemCommandRequestInfo) and waits with
            // pthread_cond_timedwait on the mutex that guards it - the wait releases the mutex, so the second command
            // overwrites the first one's request, and one thread takes the other's answer
            await t.test('both commands get their own answers', regression('system-command-slot'), () => {
                assert.equal(dutyCycle, 23, `DUTY_CYCLE ${dutyCycle}`);
                assert.deepEqual(errors, []);
            });
            assert.ok(rfd.alive);
        });
    },
);
