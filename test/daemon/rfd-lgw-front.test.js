/**
 * Stage 3: rfd against the JavaScript HM-LGW front (lib/lgw.js) - the encrypted transport (`Encryption Key`, the
 * `V` handshake, AES-128-CFB on both ports) and the reconnect scenarios of OpenCCU-Base #13/#16/#17: port 2000
 * dropped, port 2001 dropped, a silent keepalive, the gateway gone and back, a wrong serial on the first hello after a
 * drop, and a drop while a telegram is in flight (the #16 shape, under ASan the interesting one). Concept case 5.
 *
 * Timing assumptions (rfd 3.89.11): the preamble within 2 s (waitForState 10 x 200 ms); a `K` every ~1 s with the
 * `>K` expected within 4 s (keepAliveThreadFunction); the reconnect attempt at once and then every 5 s with a
 * configured IP (basetimeout, measured constant in stage 1b); the coprocessor windows as on the pty. All waits
 * here have margins of seconds. Ports 2000/2001 are fixed in rfd, so the tests run one after another.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {startRfd, spawnRfd, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {regression} from '../helpers/known.js';
import {startReceiver} from '../helpers/rpc.js';
import {
    attachSwitch,
    attachRemote,
    pairSwitch,
    pairDevice,
    waitForEvent,
    REMOTE_SERIAL,
    REMOTE_ADDRESS,
    SWITCH_ADDRESS,
} from '../helpers/switch.js';

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

test(
    'AES: rfd connects through the encrypted gateway - V handshake on both ports, keepalives, the init',
    options(),
    async (t) => {
        const rfd = await startRfd({lgwFront: {serial: SERIAL, key: KEY}});
        await withDaemon(rfd, async () => {
            const {lgw, module} = rfd;
            const interfaces = await rfd.call('listBidcosInterfaces');
            t.diagnostic(`listBidcosInterfaces: ${JSON.stringify(interfaces)}`);
            assert.equal(interfaces[0].CONNECTED, true);
            assert.equal(interfaces[0].ADDRESS, SERIAL);
            // both ports went through the V exchange: the gateway's V, the client's V, then the S/> in cipher text
            for (const kind of ['bidcos', 'keepalive']) {
                const lines = lgw.trace.filter((e) => e.kind === kind && e.line).map((e) => `${e.dir} ${e.line[0]}`);
                assert.deepEqual(
                    lines.slice(0, 5),
                    ['tx H', 'tx V', 'rx V', 'tx S', 'rx >'],
                    `${kind}: ${lines.join(', ')}`,
                );
            }
            assert.ok(rfd.grep(/Serial Number: SIM0000002/).length >= 1);
            const names = module.commands.map((c) => c.name);
            assert.equal(names[0], 'IDENTIFY', names.join(' '));
            assert.ok(names.includes('SET_RF_ADDRESS'));
            assert.equal(module.stats.crcErrors, 0, 'the cipher streams stay in step');
            await sleep(3500);
            assert.ok(lgw.keepalives >= 2, `encrypted keepalives: ${lgw.keepalives}`);
            assert.equal(rfd.grep(/Did not receive reply on keepalive/).length, 0);
            assert.ok(await connected(rfd));
        });
    },
);

test(
    'AES: a wrong LAN key - rfd decrypts garbage, sees no switch command, reports WRONG_KEY and gives the interface up',
    options(),
    async (t) => {
        const rfd = await spawnRfd({lgwFront: {serial: SERIAL, key: KEY, configuredKey: 'AnotherKey'}});
        try {
            const exit = await Promise.race([rfd.exited, sleep(30000).then(() => null)]);
            t.diagnostic(`rfd with the wrong key: ${exit ? `exited ${JSON.stringify(exit)}` : 'still running'}`);
            assert.ok(rfd.grep(/Didn't receive switch protocol command/).length >= 1, rfd.tail(30));
            assert.ok(exit, 'rfd gives up the interface and exits (measured on 3.89.11)');
            assert.equal(exit.code, 0);
            assert.ok(
                rfd.lgw.trace.some((e) => e.kind === 'bidcos' && e.line && e.line.startsWith('V')),
                'the handshake was attempted',
            );
        } finally {
            await rfd.stop();
        }
    },
);

test('plaintext through the JavaScript front: no V, the same init as through hmlangw', options(), async () => {
    const rfd = await startRfd({lgwFront: {serial: SERIAL}});
    await withDaemon(rfd, async () => {
        assert.ok(await connected(rfd));
        const lines = rfd.lgw.trace.filter((e) => e.kind === 'bidcos' && e.line).map((e) => `${e.dir} ${e.line[0]}`);
        assert.deepEqual(lines.slice(0, 3), ['tx H', 'tx S', 'rx >']);
        assert.equal(rfd.module.commands[0].name, 'IDENTIFY');
    });
});

for (const kind of ['bidcos', 'keepalive']) {
    test(
        `AES: port ${kind === 'bidcos' ? '2000' : '2001'} dropped - rfd reconnects both ports and re-initialises the module (#13)`,
        options(regression(13)),
        async (t) => {
            const rfd = await startRfd({lgwFront: {serial: SERIAL, key: KEY}});
            await withDaemon(rfd, async () => {
                const {lgw, module} = rfd;
                assert.ok(await connected(rfd));
                const identifies = module.commands.filter((c) => c.name === 'IDENTIFY').length;
                const clientsBefore = {...lgw.clientsSeen};
                const at = Date.now();
                lgw.drop(kind);
                // a reconnect: both clients come back, the coprocessor is initialised again, "Reconnected." is logged
                await waitUntil(
                    () =>
                        lgw.clientsSeen.bidcos > clientsBefore.bidcos &&
                        lgw.clientsSeen.keepalive > clientsBefore.keepalive,
                    30000,
                    'both ports reconnected',
                );
                await module.waitForCommand('IDENTIFY', {count: identifies + 1, timeout: 20000});
                await waitUntil(() => rfd.grep(/Reconnected/).length >= 1, 15000, 'the Reconnected log line');
                t.diagnostic(`reconnected ${Date.now() - at} ms after port ${kind} was dropped`);
                assert.ok(await connected(rfd));
                assert.ok(rfd.alive);
                assert.equal(module.stats.crcErrors, 0);
            });
        },
    );
}

test('AES: a silent keepalive - no >K within 4 s makes rfd reconnect', options(), async (t) => {
    const rfd = await startRfd({lgwFront: {serial: SERIAL, key: KEY}});
    await withDaemon(rfd, async () => {
        const {lgw} = rfd;
        assert.ok(await connected(rfd));
        const clientsBefore = lgw.clientsSeen.keepalive;
        const at = Date.now();
        lgw.answerKeepalive = false;
        await waitUntil(
            () => rfd.grep(/Did not receive reply on keepalive/).length >= 1,
            15000,
            'the keepalive timeout',
        );
        lgw.answerKeepalive = true;
        await waitUntil(() => lgw.clientsSeen.keepalive > clientsBefore, 30000, 'a new keepalive client');
        await waitUntil(() => connected(rfd), 30000, 'CONNECTED after the reconnect');
        t.diagnostic(`keepalive timeout and reconnect took ${Date.now() - at} ms`);
        assert.ok(rfd.alive);
    });
});

test(
    'AES: the gateway gone and back; the first hello after it says another serial and is rejected, the next one accepted (#17)',
    options(regression(17)),
    async (t) => {
        const rfd = await startRfd({lgwFront: {serial: SERIAL, key: KEY}});
        await withDaemon(rfd, async () => {
            const {lgw} = rfd;
            assert.ok(await connected(rfd));
            await lgw.lose();
            await waitUntil(async () => !(await connected(rfd)), 15000, 'CONNECTED = false');
            lgw.serialOverrideOnce = 'OTHER00001';
            await lgw.reappear();
            const at = Date.now();
            await waitUntil(() => rfd.grep(/does not match reported serial/).length >= 1, 30000, 'the rejected hello');
            await waitUntil(() => connected(rfd), 40000, 'CONNECTED after the retry with the right serial');
            t.diagnostic(`rejected once, connected ${Date.now() - at} ms after the gateway was back`);
            assert.ok(rfd.alive);
        });
    },
);

test(
    'AES: port 2000 dropped while a telegram is in flight - no crash, the set fails, the reconnect follows (#16 shape)',
    options(regression(16)),
    async (t) => {
        const rfd = await startRfd({lgwFront: {serial: SERIAL, key: KEY}});
        const receiver = await startReceiver();
        await withDaemon(rfd, async () => {
            const {lgw, air, device} = {...rfd, ...attachSwitch(rfd)};
            await rfd.call('init', [receiver.url, 'hmrs']);
            await receiver.waitFor('newDevices', 15000);
            await pairSwitch(rfd, receiver, air, device);
            // the device takes long to acknowledge; the port goes away in the middle of the wait
            const ackDelayMs = rfd.module.options.ackDelayMs;
            rfd.module.options.ackDelayMs = 1500;
            const started = Date.now();
            const pending = rfd.call('setValue', [`${device.serial}:1`, 'STATE', true], {timeout: 60000}).then(
                (result) => ({result}),
                (error) => ({error}),
            );
            await sleep(400);
            lgw.drop('bidcos');
            const outcome = await pending;
            t.diagnostic(`the set returned after ${Date.now() - started} ms: ${JSON.stringify(outcome).slice(0, 100)}`);
            assert.ok(rfd.alive, `rfd died: ${JSON.stringify(rfd.exit)}`);
            rfd.module.options.ackDelayMs = ackDelayMs;
            await waitUntil(() => connected(rfd), 40000, 'CONNECTED after the reconnect');
            await waitUntil(() => rfd.grep(/Reconnected/).length >= 1, 15000, 'the Reconnected log line');
            // and the device is reachable again
            await rfd.call('setValue', [`${device.serial}:1`, 'STATE', false]);
            await waitForEvent(receiver, `${device.serial}:1`, 'STATE', false, {from: 0});
            assert.equal(
                rfd.sanitizerReports().length,
                0,
                rfd
                    .sanitizerReports()
                    .map((r) => r.text)
                    .join('\n'),
            );
        }).finally(() => receiver.stop());
    },
);

test(
    'AES: the module power-cycled behind the gateway - rfd republishes the paired devices and keys (restoreConfigToCoprocessor), but not the AES policy',
    options(),
    async (t) => {
        const rfd = await startRfd({lgwFront: {serial: SERIAL, key: KEY}});
        const receiver = await startReceiver();
        await withDaemon(rfd, async () => {
            const {lgw, module, air, device: sw} = {...rfd, ...attachSwitch(rfd, {aes: true})};
            const {device: rc} = attachRemote(rfd, {aes: true});
            await rfd.call('init', [receiver.url, 'hmrs']);
            await receiver.waitFor('newDevices', 15000);
            await pairDevice(rfd, receiver, air, sw);
            await pairDevice(rfd, receiver, air, rc);
            assert.ok(module.peers.has(SWITCH_ADDRESS) && module.peers.has(REMOTE_ADDRESS));
            // the module loses everything (power-cycled), the gateway comes back on it
            await lgw.lose();
            module.peers.clear();
            module.keyTable.clear();
            module.authentication.clear();
            module.currentKeyIndex = 0;
            const commandsBefore = module.commands.length;
            await lgw.reappear();
            await waitUntil(() => connected(rfd), 40000, 'CONNECTED after the reconnect');
            await waitUntil(() => rfd.grep(/Reconnected/).length >= 1, 15000, 'the Reconnected log line');
            await waitUntil(
                () => module.peers.has(SWITCH_ADDRESS) && module.peers.has(REMOTE_ADDRESS),
                15000,
                'ADD_LINK_PEER for both devices',
            );
            const names = () => module.commands.slice(commandsBefore).map((c) => c.name);
            assert.ok(names().includes('SET_CURRENT_AES_KEY'), `the key table is restored: ${names().join(' ')}`);
            assert.ok(module.keyTable.has(1));
            // the switch works again: a set through the handshake (the device challenges, the air answers from the
            // restored key table)
            await rfd.call('setValue', [`${sw.serial}:1`, 'STATE', true]);
            assert.equal(sw.behaviour.channel(1).STATE, 200);
            // the finding: republishAllDevices re-adds the devices and keys, but the per-channel AES policy is not
            // set again, so the module does not authenticate the remote's key events and rfd rejects them
            const policyBack = await waitUntil(
                () => {
                    const policy = module.authentication.get(REMOTE_ADDRESS);
                    return !!policy && [1, 2, 3, 4].every((c) => policy.channels.has(c));
                },
                5000,
                'AUTHENTICATION_ON for the remote',
            ).then(
                () => true,
                () => false,
            );
            t.diagnostic(`after the reconnect the module saw: ${names().join(' ')}`);
            await t.test('the AES policy of the remote is restored', regression('aes-republish'), () => {
                assert.ok(policyBack, "no AUTHENTICATION_ON for the remote's keys after the re-init");
            });
            const from = receiver.received.length;
            air.press(rc, 1);
            const pressed = await waitForEvent(receiver, `${REMOTE_SERIAL}:1`, 'PRESS_SHORT', true, {
                from,
                timeout: 8000,
            }).then(
                () => true,
                () => false,
            );
            await t.test('a key press after the re-init reaches the receiver', regression('aes-republish'), () => {
                assert.ok(pressed, 'PRESS_SHORT was rejected: the module reported it unauthenticated');
            });
            assert.ok(rfd.alive);
            assert.equal(module.stats.crcErrors, 0);
        }).finally(() => receiver.stop());
    },
);
