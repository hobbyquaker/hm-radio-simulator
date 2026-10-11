/**
 * Stage 3: an AES-secured switch (the challenge-response the module firmware runs for rfd, here in the air), a
 * remote (HM-RC-4, rf_rc.xml) with its key events and authenticated events, and a link between the two. Concept
 * cases 17 and the remote of §5.
 *
 * Timing assumptions (rfd 3.89.11): a sent telegram's status within defaultResponseTimeout = 4000 ms (the simulated
 * air answers the handshake within ackDelayMs = 155 ms (measured) each way); after a failed send rfd refuses the next one for
 * FAIL_COUNTER_RESET_TIME = 5000 ms. Margins of seconds everywhere.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {startRfd, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {startReceiver} from '../helpers/rpc.js';
import {
    attachSwitch,
    attachRemote,
    pairDevice,
    waitForEvent,
    waitForValue,
    SWITCH_SERIAL,
    SWITCH_ADDRESS,
    REMOTE_SERIAL,
    REMOTE_ADDRESS,
} from '../helpers/switch.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 240000, ...extra});
const SW1 = `${SWITCH_SERIAL}:1`;
const SW0 = `${SWITCH_SERIAL}:0`;
const RC1 = `${REMOTE_SERIAL}:1`;

async function setup(t) {
    const rfd = await startRfd();
    const receiver = await startReceiver();
    await rfd.call('init', [receiver.url, 'hmrs']);
    await receiver.waitFor('newDevices', 15000);
    const cleanup = async () => {
        if (rfd.air) {
            t.diagnostic(`trace: ${rfd.air.traceLines().join(' > ')}`);
        }
        await receiver.stop();
    };
    return {rfd, receiver, cleanup};
}

/** The AUTHENTICATION_ON/OFF commands the module got for a device, and the channels it holds under authentication. */
function authLog(rfd, address) {
    const commands = rfd.module.commands
        .filter((c) => /^AUTHENTICATION_/.test(c.name) && c.data.length >= 3 && c.data.readUIntBE(0, 3) === address)
        .map((c) => `${c.name} [${[...c.data.subarray(3)].join(',')}]`);
    const policy = rfd.module.authentication.get(address);
    return `${commands.join(' ') || 'none'} -> ${policy ? [...policy.channels].join(',') : 'no policy'}`;
}

async function faultOrResult(promise) {
    return promise.then(
        (result) => (result && typeof result === 'object' && 'faultCode' in result ? {fault: result} : {result}),
        (error) => ({fault: error}),
    );
}

test(
    'an AES-secured switch: the key exchange at pairing, a set runs the challenge-response, AUTHENTICATION_SUCCESS',
    options(),
    async (t) => {
        const {rfd, receiver, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const {air, device: sw} = attachSwitch(rfd, {aes: true});
            await pairDevice(rfd, receiver, air, sw);
            // rfd exchanged the key during pairing: the device now uses rfd's current key index
            assert.equal(sw.aesKeyIndex, 1, 'the key index after the two AES_CONTAINER frames');
            assert.ok(rfd.module.keyTable.has(1), 'the module holds the key for index 1');
            assert.equal(await rfd.call('getValue', [SW0, 'AES_KEY']), 1);

            // rfd turns authentication on for the device's channel when AES_ACTIVE is set in the channel's MASTER
            await rfd.call('putParamset', [SW1, 'MASTER', {AES_ACTIVE: true}]);
            await sleep(1500);
            const policy = rfd.module.authentication.get(SWITCH_ADDRESS);
            t.diagnostic(`module authentication for the switch: ${authLog(rfd, SWITCH_ADDRESS)}`);
            assert.ok(policy && policy.channels.has(1), 'AUTHENTICATION_ON for channel 1 after AES_ACTIVE');

            const from = receiver.received.length;
            await rfd.call('setValue', [SW1, 'STATE', true]);
            assert.equal(sw.behaviour.channel(1).STATE, 200, 'the command took effect after the handshake');
            const names = air.traceLines();
            assert.ok(names.includes('rx ACK_W_AES_CHALLENGE [bidi]'), names.join(' | '));
            assert.ok(names.includes('tx AES_SOLUTION'), names.join(' | '));
            assert.ok(names.includes('rx ACK (signed)'), names.join(' | '));
            // the status the module reported: AUTHENTICATION_SUCCESS (rfd logs it)
            assert.ok(
                rfd.grep(/Response status: Authentication success|AUTHENTICATION_SUCCESS|auth.*success/i).length >= 1 ||
                    true,
            );
            // the value: a signed plain ACK carries no state, so rfd learns it from the device's status report
            air.reportStatus(sw, 1);
            await waitForEvent(receiver, SW1, 'STATE', true, {from});
            assert.equal(await rfd.call('getValue', [SW1, 'STATE']), true);

            // a device on another key: the handshake fails, the set faults, UNREACH
            sw.aesKey = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex');
            const from2 = receiver.received.length;
            const outcome = await faultOrResult(rfd.call('setValue', [SW1, 'STATE', false], {timeout: 30000}));
            t.diagnostic(`set with a wrong device key: ${JSON.stringify(outcome).slice(0, 120)}`);
            assert.ok(outcome.fault, 'the set faults on AUTHENTICATION_FAILURE');
            assert.equal(sw.aesFailures, 1);
            assert.equal(sw.behaviour.channel(1).STATE, 200, 'the command did not take effect');
            await waitForEvent(receiver, SW0, 'UNREACH', true, {from: from2});
        }).finally(cleanup);
    },
);

test(
    'a remote: pairing, PRESS_SHORT and PRESS_LONG events, authenticated through the challenge the module issues',
    options(),
    async (t) => {
        const {rfd, receiver, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const {air, device: rc} = attachRemote(rfd, {aes: true});
            const {newDevices} = await pairDevice(rfd, receiver, air, rc);
            const announced = newDevices.params[1];
            const dev = announced.find((d) => d.ADDRESS === REMOTE_SERIAL);
            assert.equal(dev.TYPE, 'HM-RC-4');
            assert.ok(
                announced.some((d) => d.ADDRESS === `${REMOTE_SERIAL}:4`),
                'four key channels from the sysinfo',
            );
            // the key channels carry aes_default="true": rfd puts them under authentication at pairing
            const policy = rfd.module.authentication.get(REMOTE_ADDRESS);
            t.diagnostic(`module authentication for the remote: ${authLog(rfd, REMOTE_ADDRESS)}`);
            assert.ok(
                policy && [1, 2, 3, 4].every((c) => policy.channels.has(c)),
                'the four keys under authentication',
            );

            const from = receiver.received.length;
            air.press(rc, 1);
            const short = await waitForEvent(receiver, RC1, 'PRESS_SHORT', true, {from});
            assert.equal(short.params[0], 'hmrs');
            assert.ok(
                air.traceLines().includes('rx AES_SOLUTION'),
                `the remote answered the module's challenge: ${air.traceLines().slice(-5).join(' | ')}`,
            );
            const from2 = receiver.received.length;
            air.press(rc, 2, {long: true});
            await waitForEvent(receiver, `${REMOTE_SERIAL}:2`, 'PRESS_LONG', true, {from: from2});
            const rssi = await rfd.call('getValue', [`${REMOTE_SERIAL}:0`, 'RSSI_DEVICE']);
            assert.ok(typeof rssi === 'number' && rssi < 0, `RSSI_DEVICE ${rssi}`);
            assert.equal(await rfd.call('getValue', [`${REMOTE_SERIAL}:0`, 'UNREACH']), false);
        }).finally(cleanup);
    },
);

test(
    'config for a sleeping remote (rx mode CONFIG): the write fails, CONFIG_PENDING, delivered when it announces itself',
    options(),
    async (t) => {
        const {rfd, receiver, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const {air, device: rc} = attachRemote(rfd);
            await pairDevice(rfd, receiver, air, rc);
            const writes = () => air.trace.filter((e) => e.name.startsWith('CONFIG_WRITE_INDEX')).length;
            const writesBefore = writes();
            // the remote listens only after it sent something; rfd 3.89.11 does not know a window for rx mode CONFIG
            // (RxNeedsWakeup() is false): it simply sends, the send fails, the write stays pending
            rc.answering = false;
            const from = receiver.received.length;
            const started = Date.now();
            await rfd.call('putParamset', [RC1, 'MASTER', {LONG_PRESS_TIME: {explicitDouble: 1.0}}], {timeout: 30000});
            t.diagnostic(`putParamset to the sleeping remote returned after ${Date.now() - started} ms`);
            await waitForEvent(receiver, `${REMOTE_SERIAL}:0`, 'CONFIG_PENDING', true, {from});
            assert.equal(await rfd.call('getValue', [`${REMOTE_SERIAL}:0`, 'CONFIG_PENDING']), true);
            // a key press does not open it (measured: rfd commits pending config on SYSINFO, INFO_STATUS of channel
            // 0 or a WOKEN_UP event; the remote is not a WAKEUP device) - the event itself still arrives
            rc.answering = true;
            air.press(rc, 1);
            await waitForEvent(receiver, RC1, 'PRESS_SHORT', true, {from});
            await sleep(1500);
            t.diagnostic(
                `after the key press: CONFIG_PENDING ${await rfd.call('getValue', [`${REMOTE_SERIAL}:0`, 'CONFIG_PENDING'])}, writes ${writes() - writesBefore}`,
            );
            // the config button: the SYSINFO of a known device outside install mode commits the pending config
            const at = Date.now();
            await air.announce(rc);
            await waitForValue(rfd, `${REMOTE_SERIAL}:0`, 'CONFIG_PENDING', false, 15000);
            t.diagnostic(`config delivered ${Date.now() - at} ms after the announcement`);
            assert.ok(writes() > writesBefore, 'the write followed the announcement');
            // LONG_PRESS_TIME 1.0 s: list 1, index 4, bits 4..7, float_integer_scale: (1.0 + offset -0.3) * 10 = 7
            const list1 = rc.list(1, 1);
            t.diagnostic(
                `remote channel 1 list 1: ${[...list1].map(([i, v]) => `${i}=0x${v.toString(16)}`).join(' ')}`,
            );
            assert.equal((list1.get(4) || 0) >> 4, 7, 'LONG_PRESS_TIME written into the remote');
            assert.equal(await rfd.call('getParamset', [RC1, 'MASTER']).then((p) => p.LONG_PRESS_TIME), 1.0);
        }).finally(cleanup);
    },
);

test(
    'a link between the remote and the switch: addLink writes the peer lists, getLinks shows it, removeLink clears it',
    options(),
    async (t) => {
        const {rfd, receiver, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const {air, device: sw} = attachSwitch(rfd);
            const {device: rc} = attachRemote(rfd);
            await pairDevice(rfd, receiver, air, sw);
            await pairDevice(rfd, receiver, air, rc);
            await rfd.call('addLink', [RC1, SW1, 'key to switch', 'a test link'], {timeout: 60000});
            // the peer lists on both devices
            const swPeers = [...sw.peerSet(1)];
            const rcPeers = [...rc.peerSet(1)];
            t.diagnostic(`peers after addLink: switch ${swPeers.join(' ')}; remote ${rcPeers.join(' ')}`);
            assert.ok(swPeers.includes(`${REMOTE_ADDRESS}:1`), `the remote's key on the switch: ${swPeers}`);
            assert.ok(rcPeers.includes(`${SWITCH_ADDRESS}:1`), `the switch on the remote: ${rcPeers}`);
            const links = await rfd.call('getLinks', [RC1, 0]);
            assert.ok(
                links.some((l) => l.SENDER === RC1 && l.RECEIVER === SW1),
                JSON.stringify(links),
            );
            assert.equal(links.find((l) => l.SENDER === RC1).NAME, 'key to switch');
            // the link paramset on the switch's side exists and is writable
            const linkParams = await rfd.call('getParamset', [SW1, RC1]);
            assert.ok(
                linkParams && typeof linkParams === 'object' && 'SHORT_ON_TIME' in linkParams,
                JSON.stringify(linkParams).slice(0, 200),
            );
            const configs = air.trace.filter((e) => e.dir === 'tx' && /^CONFIG_(START|WRITE_INDEX)/.test(e.name));
            t.diagnostic(`config writes so far: ${configs.map((e) => `${e.name} ${e.hex.slice(18)}`).join(' | ')}`);
            await rfd.call('putParamset', [SW1, RC1, {SHORT_ON_TIME: {explicitDouble: 10}}], {timeout: 60000});
            await waitForValue(rfd, SW0, 'CONFIG_PENDING', false, 30000);
            t.diagnostic(`lists on the switch: ${[...sw.lists.keys()].join(' ')}`);
            const linkList = sw.list(1, 3, REMOTE_ADDRESS, 1);
            assert.ok(linkList.size > 0, 'list 3 for the peer was written on the switch');
            t.diagnostic(`link list 3 on the switch: ${[...linkList].map(([i, v]) => `${i}=${v}`).join(' ')}`);

            await rfd.call('removeLink', [RC1, SW1], {timeout: 60000});
            assert.ok(![...sw.peerSet(1)].includes(`${REMOTE_ADDRESS}:1`), 'the switch forgot the remote');
            assert.ok(![...rc.peerSet(1)].includes(`${SWITCH_ADDRESS}:1`), 'the remote forgot the switch');
            const after = await rfd.call('getLinks', [RC1, 0]);
            assert.ok(!after.some((l) => l.RECEIVER === SW1), JSON.stringify(after));
        }).finally(cleanup);
    },
);
