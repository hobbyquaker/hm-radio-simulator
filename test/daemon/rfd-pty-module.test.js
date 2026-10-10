/**
 * Stage 1a: rfd with the simulated RPI-RF-MOD on a pty. Concept cases 2, 3, 4 and 19.
 *
 * Timing assumptions (rfd 3.89.11): a coprocessor command is answered within coproCommandTimeout = 1000 ms, a BUSY
 * answer is retried twice after 250 ms, the init waits up to 20 x 250 ms for the application. The module here
 * answers within a few milliseconds, so the margins are two orders of magnitude.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {encodeFrame} from '../../lib/frame.js';
import {SYSTEM_STATUS} from '../../lib/commands.js';
import {mulberry32, seedFromEnvironment} from '../../lib/prng.js';
import {startRfd, spawnRfd, withDaemon, skipWithoutDaemons, CENTRAL_ADDRESS} from '../helpers/daemon.js';
import {regression, isKnownBroken} from '../helpers/known.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 180000, ...extra});

test('rfd initialises the simulated module and reports the interface CONNECTED', options(), async () => {
    const rfd = await startRfd({module: {serial: 'SIM0000001'}});
    await withDaemon(rfd, async () => {
        const {module} = rfd;
        const interfaces = await rfd.call('listBidcosInterfaces');
        assert.equal(interfaces.length, 1, JSON.stringify(interfaces));
        assert.equal(interfaces[0].ADDRESS, 'SIM0000001');
        assert.equal(interfaces[0].CONNECTED, true);
        assert.equal(interfaces[0].TYPE, 'CCU2');
        assert.equal(interfaces[0].DEFAULT, true);

        // the init sequence as rfd 3.89.11 runs it: identify, versions, CSMA/CA, serial, clock, keys, address
        const names = module.commands.map((c) => c.name);
        assert.equal(names[0], 'IDENTIFY', `first command: ${names.join(' ')}`);
        const order = ['IDENTIFY', 'GETVERSION', 'GET_SERIALNR', 'SET_CLOCK', 'SET_CURRENT_AES_KEY', 'SET_RF_ADDRESS'];
        const positions = order.map((name) => names.indexOf(name));
        for (let i = 0; i < order.length; i++) {
            assert.ok(positions[i] >= 0, `${order[i]} in ${names.join(' ')}`);
            if (i > 0) {
                assert.ok(positions[i] > positions[i - 1], `${order[i]} after ${order[i - 1]}: ${names.join(' ')}`);
            }
        }
        assert.ok(names.includes('CSMACA_ON_OFF'), `CSMACA_ON_OFF in ${names.join(' ')}`);
        assert.equal(module.rfAddress, CENTRAL_ADDRESS, 'rfd set the central address from its Address File');
        assert.ok(module.aesKeys.has('SET_CURRENT_AES_KEY'), 'rfd pushed its current key');
        assert.ok(
            module.clock && Math.abs(module.clock.utcSeconds - Date.now() / 1000) < 300,
            'the clock rfd set is now',
        );
        assert.equal(module.stats.crcErrors, 0);
        assert.ok(rfd.grep(/Firmware Version is: 2\.8\.6/).length >= 1, 'rfd logged the module firmware version');
    });
});

test('module in the bootloader at start: rfd starts the application and proceeds to CONNECTED', options(), async () => {
    const rfd = await startRfd({module: {mode: 'bootloader'}});
    await withDaemon(rfd, async () => {
        const interfaces = await rfd.call('listBidcosInterfaces');
        assert.equal(interfaces[0].CONNECTED, true);
        const names = rfd.module.commands.map((c) => c.name);
        assert.ok(
            names.indexOf('STARTBOOTLOADER') > names.indexOf('IDENTIFY'),
            `STARTBOOTLOADER after IDENTIFY: ${names.join(' ')}`,
        );
        assert.equal(rfd.module.mode, 'app');
        assert.ok(names.includes('SET_RF_ADDRESS'));
    });
});

test('a BUSY answer to GET_SERIALNR is retried by rfd (250 ms, twice) and the init completes', options(), async () => {
    // the fault has to be in place before rfd's first command, so spawn first and wait afterwards
    const rfd = await spawnRfd();
    rfd.module.inject('GET_SERIALNR', {status: SYSTEM_STATUS.BUSY});
    await rfd.waitReady();
    await withDaemon(rfd, async () => {
        const interfaces = await rfd.call('listBidcosInterfaces');
        assert.equal(interfaces[0].CONNECTED, true);
        assert.equal(interfaces[0].ADDRESS, rfd.module.serial);
        const serialCommands = rfd.module.commands.filter((c) => c.name === 'GET_SERIALNR');
        assert.ok(serialCommands.length >= 2, `GET_SERIALNR was retried: ${serialCommands.length}`);
        assert.ok(rfd.grep(/coprocessor was busy/).length >= 1, 'rfd logged the busy retry');
    });
});

test(
    'module lost: the pty hangs up - rfd stays alive without spinning (#115) and reports CONNECTED false (#116)',
    options(),
    async (t) => {
        const rfd = await startRfd();
        try {
            assert.equal((await rfd.call('listBidcosInterfaces'))[0].CONNECTED, true);
            await rfd.pty.lose();
            await sleep(3000);

            await t.test('rfd survives the hangup', regression(115), async () => {
                assert.ok(rfd.alive, `rfd exited: ${JSON.stringify(rfd.exit)}\n${rfd.tail(20)}`);
            });
            if (rfd.alive) {
                // no busy loop on the dead device: 2 s of wall time must not cost 2 s of CPU
                const before = rfd.cpuTicks();
                await sleep(2000);
                const ticks = rfd.cpuTicks() - before;
                t.diagnostic(`rfd used ${ticks} clock ticks in the 2 s after the hangup`);
                await t.test('no busy loop after the hangup', regression(115), () => {
                    assert.ok(ticks < 100, `rfd used ${ticks} clock ticks (of 200) in 2 s after the hangup`);
                });
                await t.test(
                    'listBidcosInterfaces reports the interface as not connected',
                    regression(116),
                    async () => {
                        const interfaces = await rfd.call('listBidcosInterfaces', [], {timeout: 5000});
                        assert.equal(interfaces[0].CONNECTED, false);
                    },
                );
            } else {
                t.diagnostic(`rfd exited after the hangup: ${JSON.stringify(rfd.exit)} (known: ${isKnownBroken(115)})`);
            }
        } finally {
            await rfd.stop();
        }
    },
);

test('module back: a fresh rfd on a reappeared module reaches CONNECTED again', options(), async () => {
    const first = await startRfd();
    const {module, pty} = first;
    first.pty = null; // keep the pty across the restart
    first.module = null;
    await first.stop();
    await pty.reappear();
    module.commands.length = 0;
    const second = await startRfd({interfaces: [{type: 'CCU2', dev: pty.link}]});
    second.module = module;
    second.pty = pty;
    await withDaemon(second, async () => {
        assert.equal((await second.call('listBidcosInterfaces'))[0].CONNECTED, true);
        assert.equal(module.commands[0].name, 'IDENTIFY');
    });
});

test('events from the module reach rfd without harm: an unknown device, a duty-cycle event', options(), async () => {
    const rfd = await startRfd();
    await withDaemon(rfd, async () => {
        const {module} = rfd;
        module.sendEvent({counter: 1, flags: 0x84, type: 0x40, src: 0xabcdef, dst: CENTRAL_ADDRESS, payload: [1, 5]});
        module.sendEvent({
            counter: 2,
            flags: 0x80,
            type: 0x10,
            src: 0xabcdef,
            dst: CENTRAL_ADDRESS,
            payload: [0x06, 0x01, 0xc8, 0x00],
        });
        module.sendDutyCycleEvent(42);
        await sleep(1500);
        assert.ok(rfd.alive);
        assert.ok(rfd.grep(/Duty cycle event/i).length >= 1, 'rfd logged the duty-cycle event');
        assert.equal((await rfd.call('listBidcosInterfaces'))[0].CONNECTED, true);
    });
});

test('frame fuzzing: random frames and garbage on the pty do not crash rfd (seeded)', options(), async (t) => {
    const seed = seedFromEnvironment();
    t.diagnostic(`HMRS_SEED=${seed}`);
    const rng = mulberry32(seed);
    const rfd = await startRfd();
    await withDaemon(rfd, async () => {
        const {module} = rfd;
        const iterations = Number(process.env.HMRS_FUZZ_FRAMES || 400);
        for (let i = 0; i < iterations; i++) {
            const kind = rng.int(5);
            let bytes;
            if (kind === 0) {
                bytes = rng.bytes(1 + rng.int(40)); // garbage
            } else if (kind === 1) {
                bytes = encodeFrame(rng.bytes(rng.int(70))); // a valid frame, random payload
            } else if (kind === 2) {
                // a BidCoS event of a plausible size with random content
                bytes = encodeFrame(
                    Buffer.concat([
                        Buffer.from([0x01, rng.byte(), 0x05, rng.byte(), rng.byte(), rng.byte()]),
                        rng.bytes(9 + rng.int(18)),
                    ]),
                );
            } else if (kind === 3) {
                // a system frame with a random command and status
                bytes = encodeFrame(
                    Buffer.concat([Buffer.from([0x00, rng.byte(), rng.int(16), rng.int(6)]), rng.bytes(rng.int(12))]),
                );
            } else {
                // a valid frame with a corrupted byte
                bytes = encodeFrame(rng.bytes(5 + rng.int(20)));
                bytes[1 + rng.int(bytes.length - 1)] = rng.byte();
            }
            module.writeRaw(bytes);
            if (i % 10 === 0) {
                await sleep(5);
            }
        }
        await sleep(2000);
        assert.ok(rfd.alive, `rfd died during frame fuzzing (seed ${seed}): ${JSON.stringify(rfd.exit)}`);
        assert.equal((await rfd.call('listBidcosInterfaces'))[0].CONNECTED, true);
        const reports = rfd.sanitizerReports();
        assert.equal(reports.length, 0, `sanitizer reports (seed ${seed}):\n${reports.map((r) => r.text).join('\n')}`);
    });
});
