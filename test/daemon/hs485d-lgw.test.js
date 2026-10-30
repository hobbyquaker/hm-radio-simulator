/**
 * Stage 4: hs485d (`-g`) against the HMW-LGW in JavaScript (lib/hmwlgw.js) with one wired switch actuator
 * (HMW-LC-Sw2-DR from the image's hs485types) on the simulated bus (lib/wired.js). Concept §3.2 E.
 *
 * Timing assumptions (hs485d 3.89.11): the gateway's answer to a command within HS485_RESPONSE_TIMEOUT = 700 ms
 * (the simulated bus answers in 20 ms); the keepalive `K` every 20 s, a missing answer makes hs485d reconnect at once
 * and then every 5 s (LGWPortWrapper::reconnect, basetimeout, growing by 5 s); discovery answers collected for
 * 3 x 700 ms; a failed send is retried once (maxRetries = 2) with HS485_LGW_TIMEOUT = 200 ms each. Margins of
 * seconds everywhere; the keepalive tests wait for hs485d's 20 s.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {startHs485d, spawnHs485d, withDaemon, skipWithoutDaemons, HS485TYPES} from '../helpers/daemon.js';
import {startReceiver} from '../helpers/rpc.js';
import {waitForEvent, waitForValue} from '../helpers/switch.js';
import {loadDeviceDescription} from '../../lib/rftypes.js';
import {WiredBus, WiredDevice} from '../../lib/wired.js';
import {HMW_LGW_PORT} from '../../lib/hmwlgw.js';
import {createEq3LanDevice} from '../../lib/eq3udp.js';
import {regression} from '../helpers/known.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 240000, ...extra});
const SERIAL = 'SIMW000001';
const ADDRESS = 0x00004711;
const TYPE = 'HMW-LC-Sw2-DR';
const SYSINFO = [0x11, 0x00, 0x03, 0x05]; // type 17, hardware 0, firmware 3.05 (>= 3.03 as the description asks)
const SW3 = `${SERIAL}:3`; // the first switch channel (physical channel 2)
const KEY1 = `${SERIAL}:1`; // the first key (physical channel 0)

let wiredDescription = null;
function switchDescription() {
    if (!wiredDescription) {
        wiredDescription = loadDeviceDescription(path.join(HS485TYPES, 'hmw_lc_sw2_dr.xml'));
    }
    return wiredDescription;
}

function makeSwitch(options = {}) {
    return new WiredDevice({
        address: ADDRESS,
        serial: SERIAL,
        description: switchDescription(),
        typeId: TYPE,
        sysinfo: SYSINFO,
        ...options,
    });
}

async function waitUntil(predicate, timeoutMs, what) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (await predicate()) {
            return Date.now();
        }
        await sleep(200);
    }
    throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`);
}

/** hs485d through the gateway with a bus holding `devices`, a receiver registered. */
async function setup(t, devices = [makeSwitch()], frontOptions = {}, daemonOptions = {}) {
    const bus = new WiredBus();
    for (const d of devices) {
        bus.add(d);
    }
    const hs485d = await startHs485d({lgwFront: {serial: 'SIMWLGW001', ...frontOptions}, bus, ...daemonOptions});
    const receiver = await startReceiver();
    await hs485d.call('init', [receiver.url, 'hmrs', false]);
    const lgw = hs485d.lgw; // the daemon forgets it when stopped, the cleanup runs after that
    const cleanup = async () => {
        t.diagnostic(`bus: ${bus.traceLines().join(' > ')}`);
        t.diagnostic(`gateway: ${lgw.commandLines().join(' ')}`);
        await receiver.stop();
    };
    return {hs485d, receiver, bus, lgw, cleanup};
}

/** Waits for a newDevices call (from index `from` on) that announces `serial`; hs485d announces its own central too. */
async function waitForNewDevices(receiver, from, serial, timeout = 15000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        const found = receiver.received
            .slice(from)
            .find((r) => r.method === 'newDevices' && r.params[1].some((d) => d.ADDRESS === serial));
        if (found) {
            return found;
        }
        await sleep(100);
    }
    throw new Error(
        `no newDevices with ${serial} within ${timeout} ms; got ${receiver.received
            .slice(from)
            .map(
                (r) =>
                    `${r.method}${r.method === 'newDevices' ? `(${r.params[1].map((d) => d.ADDRESS).join(',')})` : ''}`,
            )
            .join(' ')}`,
    );
}

/** searchDevices and the newDevices call that follows. */
async function discover(hs485d, receiver, expectedCount = 1, serial = SERIAL) {
    const from = receiver.received.length;
    const count = await hs485d.call('searchDevices', [], {timeout: 60000});
    assert.equal(count, expectedCount, 'devices found');
    return waitForNewDevices(receiver, from, serial);
}

test(
    'hs485d connects through the gateway: the hello and the switch, an empty bus, the keepalive every 20 s',
    options(),
    async (t) => {
        const {hs485d, lgw, cleanup} = await setup(t, []);
        await withDaemon(hs485d, async () => {
            const lines = lgw.trace.filter((e) => e.line).map((e) => `${e.dir} ${e.line[0]}`);
            assert.deepEqual(lines.slice(0, 3), ['tx H', 'tx S', 'rx >']);
            assert.ok(hs485d.grep(/Serial Number: SIMWLGW001/).length >= 1, 'hs485d logged the gateway');
            // hs485d lists its own central (BidCoS-Wir with its channels) even on an empty bus
            const devices = await hs485d.call('listDevices');
            assert.ok(
                devices.length > 0 && devices.every((d) => d.ADDRESS.startsWith('BidCoS-Wir')),
                JSON.stringify(devices).slice(0, 200),
            );
            assert.equal(await hs485d.call('searchDevices', [], {timeout: 30000}), 0, 'a discovery on an empty bus');
            assert.ok(lgw.commandLines().includes('rx D'));
            // the keepalive: hs485d's thread sleeps 20 s, then sends K and expects the answer within 700 ms
            const at = Date.now();
            await waitUntil(() => lgw.keepalives >= 1, 30000, 'the first keepalive');
            t.diagnostic(`first K ${Date.now() - at} ms after the connection`);
            assert.equal(hs485d.grep(/Did not get an answer/).length, 0);
            assert.equal(lgw.clientsSeen, 1, 'no reconnect');
        }).finally(cleanup);
    },
);

test(
    'AES: hs485d through the encrypted gateway (-k): the V handshake, the binary protocol inside the cipher',
    options(),
    async (t) => {
        const {hs485d, lgw, receiver, cleanup} = await setup(t, [makeSwitch()], {key: 'WiredLanKey-42'});
        await withDaemon(hs485d, async () => {
            const lines = lgw.trace.filter((e) => e.line).map((e) => `${e.dir} ${e.line[0]}`);
            assert.deepEqual(lines.slice(0, 5), ['tx H', 'tx V', 'rx V', 'tx S', 'rx >']);
            await discover(hs485d, receiver);
            const devices = await hs485d.call('listDevices');
            assert.ok(
                devices.some((d) => d.ADDRESS === SERIAL),
                JSON.stringify(devices).slice(0, 200),
            );
        }).finally(cleanup);
    },
);

test(
    'discovery: searchDevices finds the actuator - D, d, c, then h/v, the EEPROM usage and the lists; newDevices',
    options(),
    async (t) => {
        const sw = makeSwitch();
        const {hs485d, receiver, lgw, cleanup} = await setup(t, [sw]);
        await withDaemon(hs485d, async () => {
            const call = await discover(hs485d, receiver);
            const announced = call.params[1];
            const dev = announced.find((d) => d.ADDRESS === SERIAL);
            assert.ok(dev, JSON.stringify(announced).slice(0, 300));
            assert.equal(dev.TYPE, TYPE);
            assert.equal(dev.FIRMWARE, '3.05');
            for (const ch of [0, 1, 2, 3, 4]) {
                assert.ok(
                    announced.some((d) => d.ADDRESS === `${SERIAL}:${ch}`),
                    `channel ${ch}`,
                );
            }
            const names = sw.traceLines();
            for (const name of ["rx 'h'", "rx 'v'", "rx 'n'", "rx 'E'"]) {
                assert.ok(names.includes(name), `${name} in ${names.join(' | ')}`);
            }
            // before the discovery hs485d broadcasts the sleep mode (z twice, Z twice afterwards): S frames answered a
            const commands = lgw.commandLines();
            const d = commands.indexOf('rx D');
            assert.ok(d > 0, commands.join(' '));
            assert.deepEqual(commands.slice(d, d + 3), ['rx D', 'tx d', 'tx c'], commands.join(' '));
            assert.deepEqual(sw.traceLines().slice(0, 4), ["rx 'z'", "rx 'z'", "rx 'Z'", "rx 'Z'"]);
            const devices = await hs485d.call('listDevices');
            assert.ok(devices.some((d) => d.ADDRESS === SW3 && d.TYPE === 'SWITCH'));
            assert.equal(await hs485d.call('getValue', [`${SERIAL}:0`, 'UNREACH']), false);
            // the device's MASTER paramset lives in its EEPROM: read through R
            const master = await hs485d.call('getParamset', [SERIAL, 'MASTER']);
            assert.ok('LOGGING_TIME' in master, JSON.stringify(master));
            assert.ok(sw.traceLines().includes("rx 'R'"));
        }).finally(cleanup);
    },
);

test(
    'a set: LEVEL_SET to the switch channel, the ACK, the INFO_LEVEL event; getValue asks with LEVEL_GET',
    options(),
    async (t) => {
        const sw = makeSwitch();
        const {hs485d, receiver, cleanup} = await setup(t, [sw]);
        await withDaemon(hs485d, async () => {
            await discover(hs485d, receiver);
            const from = receiver.received.length;
            await hs485d.call('setValue', [SW3, 'STATE', true]);
            assert.equal(sw.behaviour.channel(2).STATE, 200, 'the actuator switched (physical channel 2)');
            const event = await waitForEvent(receiver, SW3, 'STATE', true, {from});
            assert.equal(event.params[0], 'hmrs');
            assert.equal(await hs485d.call('getValue', [SW3, 'STATE']), true);
            const names = sw.traceLines();
            assert.ok(names.includes('rx LEVEL_SET ch2'), names.join(' | '));
            assert.ok(names.includes('tx INFO_LEVEL ch2'), names.join(' | '));
            // a read goes to the device: LEVEL_GET, answered with INFO_LEVEL
            sw.behaviour.channel(2).STATE = 0;
            assert.equal(await hs485d.call('getValue', [SW3, 'STATE']), false, 'read from the device');
            assert.ok(sw.traceLines().includes('rx LEVEL_GET ch2'));
            await hs485d.call('setValue', [SW3, 'STATE', false]);
            await waitForEvent(receiver, SW3, 'STATE', false, {from});
        }).finally(cleanup);
    },
);

test('a key press on the actuator: PRESS_SHORT and PRESS_LONG events', options(), async (t) => {
    const sw = makeSwitch();
    const {hs485d, receiver, cleanup} = await setup(t, [sw]);
    await withDaemon(hs485d, async () => {
        await discover(hs485d, receiver);
        const from = receiver.received.length;
        sw.press(0);
        await waitForEvent(receiver, KEY1, 'PRESS_SHORT', true, {from});
        sw.press(1, {long: true});
        await waitForEvent(receiver, `${SERIAL}:2`, 'PRESS_LONG', true, {from});
        // a repeated frame with the same counter and without SYN is dropped (CheckRxCounter): no second event
        const before = receiver.received.filter((r) => r.method === 'event').length;
        sw.press(0, {repeat: true});
        await sleep(1500);
        assert.equal(
            receiver.received.filter((r) => r.method === 'event' && r.params[2] === 'PRESS_SHORT').length,
            before - receiver.received.filter((r) => r.method === 'event' && r.params[2] !== 'PRESS_SHORT').length,
            'a repeated key counter is no new press',
        );
    }).finally(cleanup);
});

test('a device announces itself (A, broadcast): hs485d adds it without a search', options(), async (t) => {
    const sw = makeSwitch();
    const {hs485d, receiver, bus, cleanup} = await setup(t, [sw]);
    await withDaemon(hs485d, async () => {
        await discover(hs485d, receiver);
        const second = bus.add(makeSwitch({address: 0x00004712, serial: 'SIMW000002'}));
        const from = receiver.received.length;
        second.announce();
        const call = await waitForNewDevices(receiver, from, 'SIMW000002');
        assert.ok(
            call.params[1].some((d) => d.ADDRESS === 'SIMW000002:3'),
            'with its channels',
        );
        // the announcement carries the sysinfo and the serial, so hs485d asks neither h/v nor n - it goes straight
        // to the EEPROM (the usage bits, the lists)
        const names = second.traceLines();
        assert.ok(!names.includes("rx 'h'") && !names.includes("rx 'n'"), names.join(' | '));
        assert.ok(names.includes("rx 'E'") && names.includes("rx 'R'"), names.join(' | '));
        assert.equal(await hs485d.call('getValue', ['SIMW000002:0', 'UNREACH']), false);
    }).finally(cleanup);
});

test(
    'putParamset writes the EEPROM (W) and getParamset reads it back; the write of a key channel',
    options(),
    async (t) => {
        const sw = makeSwitch();
        const {hs485d, receiver, cleanup} = await setup(t, [sw]);
        await withDaemon(hs485d, async () => {
            await discover(hs485d, receiver);
            const writes = sw.writes;
            await hs485d.call('putParamset', [SERIAL, 'MASTER', {LOGGING_TIME: {explicitDouble: 5.0}}], {
                timeout: 30000,
            });
            assert.ok(sw.writes > writes, 'a W frame reached the device');
            // LOGGING_TIME: EEPROM address 0x0001, factor 10
            assert.equal(sw.eeprom[1], 50);
            assert.equal((await hs485d.call('getParamset', [SERIAL, 'MASTER'])).LOGGING_TIME, 5.0);
            assert.equal(await hs485d.call('getValue', [`${SERIAL}:0`, 'CONFIG_PENDING']), false);
            const keyMaster = await hs485d.call('getParamset', [KEY1, 'MASTER']);
            assert.ok('LONG_PRESS_TIME' in keyMaster, JSON.stringify(keyMaster));
            await hs485d.call('putParamset', [KEY1, 'MASTER', {LONG_PRESS_TIME: {explicitDouble: 1.5}}], {
                timeout: 30000,
            });
            assert.equal((await hs485d.call('getParamset', [KEY1, 'MASTER'])).LONG_PRESS_TIME, 1.5);
            t.diagnostic(
                `EEPROM after the writes: ${[...sw.eeprom.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`,
            );
        }).finally(cleanup);
    },
);

test(
    'a link from the key to the switch channel: addLink writes the link EEPROM, getLinks shows it, removeLink',
    options(),
    async (t) => {
        const sw = makeSwitch();
        const {hs485d, receiver, cleanup} = await setup(t, [sw]);
        await withDaemon(hs485d, async () => {
            await discover(hs485d, receiver);
            const writes = sw.writes;
            await hs485d.call('addLink', [KEY1, SW3, 'key to switch', 'a wired link'], {timeout: 60000});
            assert.ok(sw.writes > writes, 'the link paramsets were written into the EEPROM');
            const links = await hs485d.call('getLinks', [KEY1, 0]);
            assert.ok(
                links.some((l) => l.SENDER === KEY1 && l.RECEIVER === SW3),
                JSON.stringify(links),
            );
            assert.equal(links.find((l) => l.SENDER === KEY1).NAME, 'key to switch');
            const peers = await hs485d.call('getLinkPeers', [KEY1]);
            assert.ok(peers.includes(SW3), JSON.stringify(peers));
            const linkParams = await hs485d.call('getParamset', [SW3, KEY1]);
            assert.ok(
                linkParams && typeof linkParams === 'object' && Object.keys(linkParams).length > 0,
                JSON.stringify(linkParams).slice(0, 200),
            );
            await hs485d.call('removeLink', [KEY1, SW3], {timeout: 60000});
            const after = await hs485d.call('getLinks', [KEY1, 0]);
            assert.ok(!after.some((l) => l.RECEIVER === SW3), JSON.stringify(after));
        }).finally(cleanup);
    },
);

test(
    '#166 a silent device: the send fails (a 01, two tries), the set faults; the maintenance channel of a discovered device (wired-maintenance)',
    options(),
    async (t) => {
        const sw = makeSwitch();
        const {hs485d, receiver, cleanup} = await setup(t, [sw]);
        await withDaemon(hs485d, async () => {
            await discover(hs485d, receiver);
            sw.answering = false;
            const from = receiver.received.length;
            const started = Date.now();
            const outcome = await hs485d.call('setValue', [SW3, 'STATE', true], {timeout: 30000}).then(
                (result) => ({result}),
                (error) => ({error: error.message}),
            );
            t.diagnostic(
                `the set to the silent device returned after ${Date.now() - started} ms: ${JSON.stringify(outcome).slice(0, 120)}`,
            );
            assert.ok(
                'error' in outcome || (outcome.result && outcome.result.faultCode !== undefined),
                'the set faults',
            );
            assert.equal(
                hs485d.grep(/Send failed\.\.\.retrying/).length,
                2,
                'two tries (HS485ControllerLGW::SendMessage)',
            );
            // the EEPROM path: the cache flush writes W twice, fails - HS485Device::SendMessage sets the UNREACH flags
            await hs485d
                .call('putParamset', [SERIAL, 'MASTER', {LOGGING_TIME: {explicitDouble: 3.0}}], {timeout: 30000})
                .catch(() => null);
            await waitUntil(() => hs485d.grep(/WriteChunk\(0\) failed/).length >= 1, 15000, 'the failed EEPROM write');
            await sleep(1000);
            // the finding: a discovered device's channels are plain HS485Channels (SetDeviceDescription uses
            // CreateChannel() for all of them, the description's class="maintenance" is used only when a device is
            // loaded from its file), so UNREACH is "unknown internal value" here and no service event is fired
            const maintenanceEvents = (since) =>
                receiver.received
                    .slice(since)
                    .filter((r) => r.method === 'event' && r.params[1] === `${SERIAL}:0`)
                    .map((r) => `${r.params[2]}=${r.params[3]}`);
            const unreach = await hs485d.call('getValue', [`${SERIAL}:0`, 'UNREACH']);
            t.diagnostic(
                `UNREACH after the failed write: ${unreach}; events: ${maintenanceEvents(from).join(', ') || 'none'}`,
            );
            await t.test('UNREACH can be read on the maintenance channel', regression('wired-maintenance'), () => {
                assert.equal(
                    hs485d.grep(/Tried to get unknown internal value UNREACH/).length,
                    0,
                    'getValue UNREACH is answered by HS485Device',
                );
                assert.equal(unreach, true);
            });
            await t.test(
                'UNREACH and STICKY_UNREACH events after the failed write',
                regression('wired-maintenance'),
                () => {
                    // hs485d sends the maintenance events with the raw internal value, an integer 1/0 - as for a
                    // device loaded from its file (the restart test below)
                    assert.ok(
                        maintenanceEvents(from).includes('UNREACH=1'),
                        maintenanceEvents(from).join(', ') || 'none',
                    );
                    assert.ok(maintenanceEvents(from).includes('STICKY_UNREACH=1'));
                },
            );
            // the device returns: after two failures hs485d drops sends to it until its fail counter resets
            // (FAIL_COUNTER_RESET_TIME); a write every 2 s shows when the device is served again
            sw.answering = true;
            const back = Date.now();
            await waitUntil(
                async () => {
                    await hs485d
                        .call('putParamset', [SERIAL, 'MASTER', {LOGGING_TIME: {explicitDouble: 3.5}}], {
                            timeout: 30000,
                        })
                        .catch(() => null);
                    await sleep(1800);
                    return sw.eeprom[1] === 35;
                },
                40000,
                'the write after the device came back',
            );
            t.diagnostic(`the returned device was written ${Date.now() - back} ms after it came back`);
        }).finally(cleanup);
    },
);

test(
    'keepalive timeout: the gateway stops answering K - hs485d finds it again over UDP and reconnects',
    options(),
    async (t) => {
        const sw = makeSwitch();
        const {hs485d, receiver, lgw, cleanup} = await setup(t, [sw]);
        // hs485d's reconnect searches the gateway by the serial it said hello with (LGWPortWrapper::reconnect, even
        // with -h given), so a LAN device answers the UDP search with the gateway's address
        const lanDevice = await createEq3LanDevice({
            type: 'eQ3-HMW-LGW',
            serial: 'SIMWLGW001',
            ip: lgw.host,
            services: [[1, lgw.port]],
        });
        await withDaemon(hs485d, async () => {
            await discover(hs485d, receiver);
            lgw.answerKeepalive = false;
            const at = Date.now();
            await waitUntil(() => hs485d.grep(/Did not get an answer/).length >= 1, 40000, 'the keepalive timeout');
            t.diagnostic(`keepalive timeout ${Date.now() - at} ms after the first K was left unanswered`);
            lgw.answerKeepalive = true;
            await waitUntil(() => lgw.clientsSeen >= 2, 30000, 'a new client');
            await waitUntil(() => hs485d.grep(/Reconnected/).length >= 1, 15000, 'the Reconnected log line');
            t.diagnostic(`reconnected ${Date.now() - at} ms after the unanswered K`);
            assert.ok(hs485d.alive);
            const from = receiver.received.length;
            await hs485d.call('setValue', [SW3, 'STATE', true], {timeout: 30000});
            await waitForEvent(receiver, SW3, 'STATE', true, {from});
            t.diagnostic(
                `UDP requests: ${lanDevice.requests.map((r) => `${r.opcode} ${r.typeFilter || '*'} ${r.serial}`).join(', ')}`,
            );
            assert.ok(
                lanDevice.requests.some((r) => r.opcode === 'I' && r.answered),
                'the identify request was answered',
            );
            assert.ok(
                lanDevice.requests.some((r) => r.opcode === 'n' && r.answered),
                'the runtime IP request was answered',
            );
        })
            .finally(cleanup)
            .finally(() => lanDevice.close());
    },
);

test(
    '#195 AES: a set while hs485d reconnects to the gateway - nothing uses the deleted controller, the device is served again afterwards',
    options(regression('lgw-reconnect-uaf')),
    async (t) => {
        const sw = makeSwitch();
        const {hs485d, receiver, lgw, cleanup} = await setup(t, [sw], {key: 'WiredLanKey-42'});
        const lanDevice = await createEq3LanDevice({
            type: 'eQ3-HMW-LGW',
            serial: 'SIMWLGW001',
            ip: lgw.host,
            services: [[1, lgw.port]],
        });
        await withDaemon(hs485d, async () => {
            await discover(hs485d, receiver);
            // LGWPortWrapper::reconnect() deletes the old controller and then waits in connect() for the gateway's
            // hello (UnifiedLanCommController::waitForState, 10 x 200 ms = 2 s); before #195's fix pEncryption still
            // pointed into the deleted controller then. The gateway holds its hello back 1200 ms (chosen, inside the
            // 2 s), and a set goes out at once in that window.
            const helloDelayMs = 1200;
            const accept = lgw.accept.bind(lgw);
            const reconnecting = new Promise((resolve) => {
                lgw.accept = (socket) => {
                    lgw.accept = accept;
                    resolve(Date.now());
                    setTimeout(() => accept(socket), helloDelayMs);
                };
            });
            lgw.answerKeepalive = false;
            let timer;
            const at = await Promise.race([
                reconnecting,
                new Promise((resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('no reconnect within 60 s')), 60000);
                }),
            ]).finally(() => clearTimeout(timer));
            lgw.answerKeepalive = true;
            const outcome = await hs485d.call('setValue', [SW3, 'STATE', true], {timeout: 30000}).then(
                (result) => ({result}),
                (error) => ({error: error.message}),
            );
            t.diagnostic(
                `the set during the reconnect returned ${Date.now() - at} ms after the new connection: ${JSON.stringify(outcome).slice(0, 120)}`,
            );
            await waitUntil(
                () => hs485d.grep(/Reconnected/).length >= 1 || !hs485d.alive,
                15000,
                'the Reconnected log line',
            );
            assert.ok(hs485d.alive, `hs485d died: ${JSON.stringify(hs485d.exit)}`);
            assert.equal(
                hs485d.sanitizerReports().length,
                0,
                hs485d
                    .sanitizerReports()
                    .map((r) => r.text)
                    .join('\n'),
            );
            // the failed set may count against the device (fail counter); a set every 2 s shows when it is served
            const back = Date.now();
            let value = false;
            await waitUntil(
                async () => {
                    const from = receiver.received.length;
                    value = !value;
                    await hs485d.call('setValue', [SW3, 'STATE', value], {timeout: 30000}).catch(() => null);
                    await sleep(1500);
                    return receiver.received
                        .slice(from)
                        .some((r) => r.method === 'event' && r.params[1] === SW3 && r.params[2] === 'STATE');
                },
                40000,
                'a set after the reconnect',
            );
            t.diagnostic(`the device was served again ${Date.now() - back} ms after the reconnect`);
        })
            .finally(cleanup)
            .finally(() => lanDevice.close());
    },
);

test(
    'restart: the device file keeps the device, its sysinfo and config; a type byte >= 0x80 survives (#9 shape)',
    options(regression(9)),
    async (t) => {
        // a description of our own with a type byte above 0x7f, next to the image's descriptions
        const descriptions = fs.mkdtempSync(path.join('/tmp', 'hmrs-hs485types-'));
        for (const f of fs.readdirSync(HS485TYPES)) {
            fs.symlinkSync(path.join(HS485TYPES, f), path.join(descriptions, f));
        }
        const fixture = fs.readFileSync(
            path.join(
                path.dirname(new URL(import.meta.url).pathname),
                '..',
                'fixtures',
                'hs485types',
                'sim_wired_switch.xml',
            ),
            'latin1',
        );
        fs.writeFileSync(
            path.join(descriptions, 'sim_hi.xml'),
            fixture.replace('id="SIM-HMW-Sw2"', 'id="SIM-HMW-HI"').replace('const_value="17"', 'const_value="0x91"'),
            'latin1',
        );
        const hiDescription = loadDeviceDescription(path.join(descriptions, 'sim_hi.xml'));
        const hi = new WiredDevice({
            address: 0x00004791,
            serial: 'SIMW000091',
            description: hiDescription,
            typeId: 'SIM-HMW-HI',
            sysinfo: [0x91, 0x00, 0x03, 0x05],
        });
        const bus = new WiredBus();
        bus.add(makeSwitch());
        bus.add(hi);
        const dir = fs.mkdtempSync(path.join('/tmp', 'hmrs-hs485d-restart-'));
        const first = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus, dir, descriptionDir: descriptions});
        const receiver = await startReceiver();
        try {
            await first.call('init', [receiver.url, 'hmrs', false]);
            await discover(first, receiver, 2);
            const devices = await first.call('listDevices');
            assert.ok(
                devices.some((d) => d.ADDRESS === 'SIMW000091' && d.TYPE === 'SIM-HMW-HI'),
                JSON.stringify(devices).slice(0, 300),
            );
            await first.call('putParamset', [SERIAL, 'MASTER', {LOGGING_TIME: {explicitDouble: 7.5}}], {
                timeout: 30000,
            });
            await sleep(6000); // hs485d saves its device files from a timer (RequestSave 5000)
            await first.stop();
            const files = fs.readdirSync(path.join(dir, 'devices'));
            t.diagnostic(`device files: ${files.join(' ')}`);
            assert.ok(files.includes(`${SERIAL}.dev`) && files.includes('SIMW000091.dev'));
            const hiFile = fs.readFileSync(path.join(dir, 'devices', 'SIMW000091.dev'), 'latin1');
            const m = /sysinfo="([0-9A-Fa-f]+)"/.exec(hiFile);
            t.diagnostic(`sysinfo attribute of the 0x91 device: ${m ? m[1] : 'none'}`);
            assert.ok(m && m[1].toUpperCase() === '91000305', 'the sysinfo bytes as unsigned hex (#9)');
        } catch (err) {
            await receiver.stop(); // else its server keeps the test file from ending (seen on #9's parent)
            throw err;
        } finally {
            await first.stop();
        }
        // the same directory again: the devices come back from their files, no discovery
        const second = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus, dir, descriptionDir: descriptions});
        await withDaemon(second, async () => {
            await second.call('init', [receiver.url, 'hmrs', false]);
            const devices = await second.call('listDevices');
            assert.ok(
                devices.some((d) => d.ADDRESS === SERIAL),
                'the switch is back',
            );
            assert.ok(
                devices.some((d) => d.ADDRESS === 'SIMW000091' && d.TYPE === 'SIM-HMW-HI'),
                'the 0x91 device is back',
            );
            assert.equal(
                (await second.call('getParamset', [SERIAL, 'MASTER'])).LOGGING_TIME,
                7.5,
                'the config from the file',
            );
            assert.equal(await second.call('getValue', ['SIMW000091:0', 'UNREACH']), false);
            // loaded from the file, the channels come with their class: now the maintenance channel answers UNREACH
            // and fires the service events when a write fails (compare the wired-maintenance finding above)
            const sw = bus.devices.get(ADDRESS);
            sw.answering = false;
            const from = receiver.received.length;
            await second
                .call('putParamset', [SERIAL, 'MASTER', {LOGGING_TIME: {explicitDouble: 4.0}}], {timeout: 30000})
                .catch(() => null);
            await waitForValue(second, `${SERIAL}:0`, 'UNREACH', true, 20000);
            assert.equal(await second.call('getValue', [`${SERIAL}:0`, 'STICKY_UNREACH']), true);
            // measured: hs485d sends the maintenance events with the raw internal value, an integer 1/0 (getValue
            // answers the booleans of the description; rfd sends booleans in both)
            await waitForEvent(receiver, `${SERIAL}:0`, 'UNREACH', 1, {from});
            await waitForEvent(receiver, `${SERIAL}:0`, 'STICKY_UNREACH', 1, {from});
            assert.equal(second.grep(/Tried to get unknown internal value UNREACH/).length, 0);
            sw.answering = true;
            const from2 = receiver.received.length;
            await second.call('putParamset', [SERIAL, 'MASTER', {LOGGING_TIME: {explicitDouble: 4.5}}], {
                timeout: 30000,
            });
            await waitForEvent(receiver, `${SERIAL}:0`, 'UNREACH', 0, {from: from2});
            assert.equal(await second.call('getValue', [`${SERIAL}:0`, 'STICKY_UNREACH']), true, 'sticky stays');
            await second.call('setValue', [`${SERIAL}:0`, 'STICKY_UNREACH', false]);
            assert.equal(await second.call('getValue', [`${SERIAL}:0`, 'STICKY_UNREACH']), false);
        }).finally(() => receiver.stop());
    },
);

test(
    'hs485d started as OpenCCU starts it (-g -i 0 -f hs485d.conf): the serial, LAN key and address from [Interface 0], the gateway on port 1000; a missing section, another Type or no key end it with 2, an unknown option with the usage and 1',
    options(),
    async (t) => {
        // timing: hs485d connects to the gateway and answers RPC within startHs485d's ready timeout; a refused
        // configuration or option ends it at once (before any connect), the test allows 20 s
        const key = 'WiredLanKey-42';
        const args = ['-g', '-i', '0', '-f', '{config}', '-c', '-l', '0'];
        const section = (lines) => ['[Interface 0]', ...lines].join('\n');
        const good = section([
            'Type = HMWLGW',
            'Serial Number = SIMWLGW001',
            `Encryption Key = ${key}`,
            'IP Address = 127.0.0.1',
        ]);
        const {hs485d, receiver, lgw, cleanup} = await setup(
            t,
            [makeSwitch()],
            {key, port: HMW_LGW_PORT},
            {args, extra: good},
        );
        await withDaemon(hs485d, async () => {
            assert.ok(hs485d.grep(/Using configuration file/).length >= 1, 'hs485d read its configuration file');
            const lines = lgw.trace.filter((e) => e.line).map((e) => `${e.dir} ${e.line[0]}`);
            assert.deepEqual(lines.slice(0, 5), ['tx H', 'tx V', 'rx V', 'tx S', 'rx >'], 'the key from the file');
            await discover(hs485d, receiver);
        }).finally(cleanup);

        const refused = async (what, daemonOptions, pattern, code) => {
            const daemon = await spawnHs485d(daemonOptions);
            const exit = await Promise.race([daemon.exited, sleep(20000).then(() => null)]);
            await daemon.stop();
            t.diagnostic(
                `${what}: ${JSON.stringify(exit)}, ${daemon.log.find((l) => pattern.test(l)) || daemon.tail(3)}`,
            );
            assert.ok(exit, `${what}: hs485d ended`);
            assert.equal(exit.code, code, `${what}: exit code ${code}`);
            assert.ok(daemon.grep(pattern).length >= 1, `${what}\n${daemon.tail(10)}`);
            assert.deepEqual(daemon.sanitizerReports(), [], what);
        };
        // measured: PropertyMap::SetCurrentSection succeeds for a section the file does not have, so hs485d reports
        // an empty Type there - its "Cannot find Interface 0" branch is never reached
        await refused('no [Interface 0]', {args}, /Interface type +not supported/, 2);
        await refused(
            'Type HMLGW2',
            {args, extra: section(['Type = HMLGW2', 'Serial Number = SIMWLGW001', `Encryption Key = ${key}`])},
            /Interface type HMLGW2 not supported/,
            2,
        );
        await refused(
            'no Encryption Key',
            {args, extra: section(['Type = HMWLGW', 'Serial Number = SIMWLGW001'])},
            /Could not find serial number and encryption key/,
            2,
        );
        await refused('an unknown option', {args: ['-x']}, /Usage:/, 1);
    },
);

test(
    "the central's virtual key BidCoS-Wir:1 linked to the switch channel: PRESS_SHORT and PRESS_LONG send the key frame (#K) to the linked channel",
    options(),
    async (t) => {
        // timing: hs485d sends the key frame while it handles the setValue; the test gives the bus 2 s to see it
        const sw = makeSwitch();
        const {hs485d, receiver, cleanup} = await setup(t, [sw]);
        await withDaemon(hs485d, async () => {
            await discover(hs485d, receiver);
            const central = 'BidCoS-Wir:1';
            await hs485d.call('addLink', [central, SW3, 'central key', ''], {timeout: 60000});
            assert.ok((await hs485d.call('getLinkPeers', [central])).includes(SW3), 'the central key has the peer');
            const keyFrames = () => sw.trace.filter((e) => e.dir === 'rx' && e.hex.startsWith('4b')).length;
            for (const [param, n] of [
                ['PRESS_SHORT', 1],
                ['PRESS_LONG', 2],
            ]) {
                await hs485d.call('setValue', [central, param, true], {timeout: 30000});
                const until = Date.now() + 2000;
                while (keyFrames() < n && Date.now() < until) {
                    await sleep(50);
                }
                assert.equal(keyFrames(), n, `${param}: a K frame reached the switch\n${sw.traceLines().join(' | ')}`);
            }
            t.diagnostic(`frames at the switch: ${sw.traceLines().slice(-6).join(' | ')}`);
            assert.ok(hs485d.alive);
            assert.deepEqual(hs485d.sanitizerReports(), []);
        }).finally(cleanup);
    },
);
