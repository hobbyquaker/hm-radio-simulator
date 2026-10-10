/**
 * Stage 1b: rfd with `Type = HMLGW2` against hmlangw (the HM-LGW emulation, MIT) in front of the simulated module -
 * the LAN-gateway code path (CCU2LGWCommController, LGWPortWrapper, libUnifiedLanComm) in plaintext, which is also
 * openccu-lite's HM-LGW mode. Concept cases 2 (LGW) and the plaintext half of 5.
 *
 * Timing assumptions (rfd 3.89.11): the preamble on 2000 must complete within 2 s (UnifiedLanCommController's
 * waitForState, 10 x 200 ms); the keepalive thread sends `K` about once a second and wants `>K` back within 4 s;
 * hmlangw drops the keepalive socket after 20 s of silence; the reconnect loop (LGWPortWrapper::reconnectImpl) retries
 * at once, then waits `basetimeout` = 5 s, growing by 5 s per failure up to about 60 s. The coprocessor windows are
 * the same as on the pty (1000 ms per command). All assertions on time carry margins of seconds.
 *
 * Ports 2000/2001 are fixed in rfd, so these tests run one after another (the runner's concurrency is 1).
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {RadioModule} from '../../lib/module.js';
import {createHmlangwGateway, LGW_BIDCOS_PORT, LGW_KEEPALIVE_PORT} from '../../lib/hmlangw.js';
import {startRfd, spawnRfd, withDaemon, skipWithoutHmlangw, tmpdir} from '../helpers/daemon.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutHmlangw, timeout: 180000, ...extra});
const SERIAL = 'SIM0000001';

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
    'rfd with Type = HMLGW2 reaches CONNECTED through hmlangw; the keepalive on 2001 is answered',
    options(),
    async (t) => {
        const rfd = await startRfd({lgw: {serial: SERIAL}});
        await withDaemon(rfd, async () => {
            const {module, gateway} = rfd;
            const interfaces = await rfd.call('listBidcosInterfaces');
            t.diagnostic(`listBidcosInterfaces: ${JSON.stringify(interfaces)}`);
            assert.equal(interfaces.length, 1);
            assert.equal(interfaces[0].ADDRESS, SERIAL);
            assert.equal(interfaces[0].CONNECTED, true);
            assert.equal(interfaces[0].TYPE, 'HMLGW2');

            // the preamble: hmlangw saw a client on both ports, rfd logged the gateway's hello
            const ports = gateway.connections.map((c) => c.port);
            assert.ok(ports.includes(LGW_BIDCOS_PORT), `a client on 2000: ${ports}`);
            assert.ok(ports.includes(LGW_KEEPALIVE_PORT), `a client on 2001: ${ports}`);
            assert.ok(rfd.grep(/Serial Number: SIM0000001/).length >= 1, 'rfd logged the serial from the H line');
            assert.ok(rfd.grep(/Product-ID: Revilo-HM-LGW/).length >= 1, 'rfd logged the product id from the H line');

            // the coprocessor init relayed through the gateway - without GET_SERIALNR: the serial comes from rfd.conf
            // (measured: IDENTIFY GETVERSION CSMACA_ON_OFF SET_CLOCK SET_CURRENT_AES_KEY SET_PREVIOUS_KEY
            // SET_RF_ADDRESS GETDUTYCYCLE)
            const names = module.commands.map((c) => c.name);
            assert.equal(names[0], 'IDENTIFY', names.join(' '));
            for (const name of ['GETVERSION', 'SET_CLOCK', 'SET_CURRENT_AES_KEY', 'SET_RF_ADDRESS']) {
                assert.ok(names.includes(name), `${name} in ${names.join(' ')}`);
            }
            assert.ok(!names.includes('GET_SERIALNR'), 'the configured serial is not queried from the module');
            assert.equal(module.stats.crcErrors, 0);

            // keepalives: rfd sends K about once a second (LGWPortWrapper::keepAliveThreadFunction), hmlangw answers >K
            await sleep(4000);
            const keepalives = gateway.grep(/received \d+ bytes: K/);
            assert.ok(keepalives.length >= 2, `K lines at hmlangw in 4 s: ${keepalives.length}`);
            assert.equal(rfd.grep(/Did not receive reply on keepalive/).length, 0, rfd.tail(10));
            assert.equal(rfd.grep(/asyncReconnect/).length, 0, 'no reconnect while the gateway is healthy');
            assert.ok(await connected(rfd));
        });
    },
);

test('a serial that differs only in case is accepted (OpenCCU-Base #17)', options(), async () => {
    const rfd = await startRfd({lgw: {serial: SERIAL, configuredSerial: SERIAL.toLowerCase()}});
    await withDaemon(rfd, async () => {
        assert.ok(await connected(rfd));
        assert.ok(rfd.grep(/differs in letter case/).length >= 1, rfd.tail(20));
        assert.ok(rfd.grep(/Rejecting LAN gateway/).length === 0, rfd.tail(20));
    });
});

test('a gateway with the wrong serial is rejected: rfd logs it and does not come up on it', options(), async (t) => {
    const rfd = await spawnRfd({lgw: {serial: SERIAL, configuredSerial: 'OTHER00001'}});
    try {
        const exit = await Promise.race([rfd.exited, sleep(30000).then(() => null)]);
        t.diagnostic(`rfd after the rejected gateway: ${exit ? `exited ${JSON.stringify(exit)}` : 'still running'}`);
        assert.ok(rfd.grep(/does not match reported serial/).length >= 1, rfd.tail(30));
        if (exit) {
            assert.equal(exit.code, 0, 'rfd exits with code 0 on an interface error (measured on 3.89.11)');
        } else {
            const interfaces = await rfd.call('listBidcosInterfaces', [], {timeout: 5000});
            assert.ok(!interfaces.some((i) => i.CONNECTED), JSON.stringify(interfaces));
        }
        assert.ok(
            !rfd.module.commands.some((c) => c.name === 'SET_RF_ADDRESS'),
            'no init through the rejected gateway',
        );
    } finally {
        await rfd.stop();
    }
});

test('no gateway at start: rfd cannot connect and gives up on the interface', options(), async (t) => {
    const rfd = await spawnRfd({interfaces: [{type: 'HMLGW2', serial: SERIAL, ip: '127.0.0.1'}]});
    try {
        const exit = await Promise.race([rfd.exited, sleep(30000).then(() => null)]);
        t.diagnostic(`rfd without a gateway: ${exit ? `exited ${JSON.stringify(exit)}` : 'still running'}`);
        assert.ok(rfd.grep(/Cannot connect to HomeMatic Lan Gateway/).length >= 1, rfd.tail(30));
        assert.ok(exit, `rfd kept running without its gateway:\n${rfd.tail()}`);
        assert.equal(exit.code, 0, 'rfd exits with code 0 on an interface error (measured on 3.89.11)');
    } finally {
        await rfd.stop();
    }
});

test(
    'gateway lost and back: CONNECTED false while it is gone, rfd reconnects and re-initialises the module',
    options(),
    async (t) => {
        const rfd = await startRfd({lgw: {serial: SERIAL}});
        await withDaemon(rfd, async () => {
            const {module, gateway} = rfd;
            assert.ok(await connected(rfd));
            const identifiesBefore = module.commands.filter((c) => c.name === 'IDENTIFY').length;

            const lostAt = Date.now();
            await gateway.lose();
            const noticedAt = await waitUntil(async () => !(await connected(rfd)), 15000, 'CONNECTED = false');
            t.diagnostic(`rfd reported the gateway lost after ${noticedAt - lostAt} ms`);
            assert.ok(rfd.alive);
            const before = rfd.cpuTicks();
            await sleep(2000);
            const ticks = rfd.cpuTicks() - before;
            t.diagnostic(`rfd used ${ticks} clock ticks in 2 s without the gateway`);
            assert.ok(ticks < 100, `no busy loop without the gateway: ${ticks} ticks of 200`);

            await gateway.reappear();
            const backAt = Date.now();
            // the first retry is immediate (refused, the gateway was still gone), the next one 5 s later finds it
            const reconnectedAt = await waitUntil(
                () => connected(rfd),
                40000,
                'CONNECTED = true after the gateway is back',
            );
            t.diagnostic(`rfd reconnected ${reconnectedAt - backAt} ms after the gateway was back`);
            // CONNECTED turns true with the preamble; the coprocessor re-init (reinitCoprocessor: improvedInit and
            // the config restore) follows over the new connection and ends with "Reconnected." in the log
            await module.waitForCommand('IDENTIFY', {count: identifiesBefore + 1, timeout: 15000});
            await module.waitForCommand('SET_CLOCK', {count: 2, timeout: 15000});
            await waitUntil(() => rfd.grep(/Reconnected/).length >= 1, 15000, 'the "Reconnected" log line');
            assert.ok(
                gateway.connections.filter((c) => c.port === LGW_BIDCOS_PORT).length >= 1,
                'the new hmlangw saw rfd',
            );
            assert.equal(module.stats.crcErrors, 0);
        });
    },
);

test(
    'reconnect retry: a constant basetimeout (5 s) between attempts when the IP address is configured',
    options(),
    async (t) => {
        const rfd = await startRfd({lgw: {serial: SERIAL}});
        await withDaemon(rfd, async () => {
            const {gateway} = rfd;
            assert.ok(await connected(rfd));
            await gateway.lose();

            // a stand-in on 2000 that accepts rfd's connection and closes it without a word: every attempt is visible
            const attempts = [];
            const decoy = net.createServer((socket) => {
                attempts.push(Date.now());
                socket.destroy();
            });
            await new Promise((resolve, reject) => {
                decoy.once('error', reject);
                decoy.listen(LGW_BIDCOS_PORT, '127.0.0.1', resolve);
            });
            try {
                await waitUntil(() => attempts.length >= 3, 60000, 'three reconnect attempts');
            } finally {
                await new Promise((resolve) => decoy.close(() => resolve()));
            }
            const gaps = attempts.slice(1).map((at, i) => (at - attempts[i]) / 1000);
            t.diagnostic(`gaps between attempts: ${gaps.map((g) => g.toFixed(1)).join(' s, ')} s`);
            // each attempt costs the 2 s hello wait, then basetimeout = 5 s. The growth by 5 s per failure up to about
            // 60 s (LGWPortWrapper::reconnectImpl) only applies when the gateway is searched by serial: with a configured
            // IP Address the loop resets the timeout to basetimeout on every attempt (measured on 3.89.11: 7.0 s, 7.0 s).
            for (const gap of gaps) {
                assert.ok(gap >= 5.5 && gap <= 9.5, `gap ${gap} s: basetimeout 5 s plus the 2 s hello wait (${gaps})`);
            }
            assert.ok(Math.abs(gaps[1] - gaps[0]) <= 1.5, `the interval does not grow with a configured IP: ${gaps}`);
            // the decoy closes before the hello, which rfd's state machine reports as "Could not connect"
            assert.ok(rfd.grep(/Could not connect|Didn't receive hello message/).length >= 2, rfd.tail(20));

            await gateway.reappear();
            const backAt = Date.now();
            const reconnectedAt = await waitUntil(() => connected(rfd), 60000, 'CONNECTED after the back-off');
            t.diagnostic(`rfd reconnected ${reconnectedAt - backAt} ms after the gateway was back`);
            assert.ok(rfd.alive);
        });
    },
);

test('hmlangw without -b parks the module in the bootloader while no client is connected', options(), async (t) => {
    const module = new RadioModule({serial: SERIAL});
    const dir = tmpdir('hmrs-lgw');
    const gateway = await createHmlangwGateway({module, dir, bootloaderOnDisconnect: true});
    try {
        // hmlangw sends its enter-bootloader frame at start and waits for the module's Co_CPU_BL announcement
        await waitUntil(() => module.mode === 'bootloader', 5000, 'the module in the bootloader');
        const enter = module.commands.find((c) => c.name === 'STARTBOOTLOADER');
        assert.ok(enter && enter.counter === 0, `hmlangw's enter-bootloader command: ${JSON.stringify(enter)}`);
        assert.ok(gateway.alive, 'hmlangw accepted the announcement and went on to open its ports');

        const rfd = await startRfd({interfaces: [{type: 'HMLGW2', serial: SERIAL, ip: gateway.host}]});
        rfd.module = module;
        try {
            assert.ok(await connected(rfd));
            assert.equal(module.mode, 'app', 'rfd started the application');
            // hmlangw's own enter-bootloader commands come first (it retries once past the OK answer, which the
            // restarting module ignores); rfd's IDENTIFY sees Co_CPU_BL and its STARTBOOTLOADER starts the app
            const names = module.commands.map((c) => c.name);
            const fromRfd = names.slice(names.indexOf('IDENTIFY'));
            assert.ok(fromRfd.includes('STARTBOOTLOADER'), names.join(' '));
        } finally {
            rfd.module = null;
            await rfd.stop();
        }
        // the client is gone: hmlangw puts the module back into the bootloader
        const at = Date.now();
        await waitUntil(() => module.mode === 'bootloader', 5000, 'the module back in the bootloader');
        t.diagnostic(`module parked in the bootloader ${Date.now() - at} ms after rfd left`);
    } finally {
        await gateway.close();
        module.close();
    }
});
