/**
 * rfd's CBC-MAC check of incoming events, `RFChannel::performCBCAuthentification` - the path OpenCCU-Base #4
 * (8ecd25e9) changed for OpenSSL 3 (no PKCS7 padding on the single-block AES-ECB steps). Whether #4 changed rfd's
 * output is doubtful (the code calls EVP_EncryptUpdate without EVP_EncryptFinal, which emits full blocks either way),
 * so these tests pin the path more than they prove the fix.
 *
 * No channel of the image's rftypes carries `aes_cbc="true"` (OpenCCU-Base ships none; the code path is there for
 * sensors that sign their events this way), so the test runs rfd on a copy of the rftypes in which the switch channel
 * of HM-LC-Sw1-Pl (rf_s.xml) has the attribute added. The simulated switch then sends its INFO_LEVEL with a 24-bit
 * counter and a 4-byte MIC (lib/aes.js cbcSign), and the module reports it as not authenticated by itself (the
 * module's challenge-response is for commands; this is chosen, not measured), so rfd checks the MIC.
 *
 * What rfd does (main and 3.89.11, RFChannel.cpp): a device with AES key index 0 is accepted unchecked (backwards
 * compatibility); otherwise the counter must be greater than the stored one, the MIC must match, and only then is the
 * counter stored (`aes_cbc_cnt` in the device file) and the event processed.
 *
 * Timing assumptions: events reach the receiver within ~1 s; waits of 3 to 15 s.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {startRfd, withDaemon, skipWithoutDaemons, tmpdir, RFTYPES, TEST_KEY_HEX} from '../helpers/daemon.js';
import {regression} from '../helpers/known.js';
import {startReceiver} from '../helpers/rpc.js';
import {attachSwitch, pairDevice, waitForEvent, eventValues, SWITCH_SERIAL} from '../helpers/switch.js';
import {cbcSign} from '../../lib/aes.js';
import {EVENT_AUTH} from '../../lib/commands.js';

const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 240000, ...extra});
const SW1 = `${SWITCH_SERIAL}:1`;
const SW0 = `${SWITCH_SERIAL}:0`;
const KEY = Buffer.from(TEST_KEY_HEX, 'hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A copy of the rftypes (links to the image's files) in which rf_s.xml's switch channel is an `aes_cbc` channel. */
function cbcDescriptions() {
    const dir = tmpdir('hmrs-rftypes-cbc');
    for (const name of fs.readdirSync(RFTYPES)) {
        if (name !== 'rf_s.xml') {
            fs.symlinkSync(path.join(RFTYPES, name), path.join(dir, name));
        }
    }
    const xml = fs.readFileSync(path.join(RFTYPES, 'rf_s.xml'), 'latin1');
    const patched = xml.replace('<channel index="1" type="SWITCH"', '<channel index="1" type="SWITCH" aes_cbc="true"');
    assert.notEqual(patched, xml, 'the switch channel of rf_s.xml was found');
    fs.writeFileSync(path.join(dir, 'rf_s.xml'), patched, 'latin1');
    return dir;
}

/**
 * rfd on the patched descriptions with a paired switch; with `aes` the key exchange at pairing gives the device key
 * index 1, and AES_ACTIVE is set on the channel (rfd then checks the CBC-MAC).
 */
async function setup({aes = true, dir = null, descriptionDir = cbcDescriptions()} = {}) {
    const rfd = await startRfd({descriptionDir, dir});
    const receiver = await startReceiver();
    await rfd.call('init', [receiver.url, 'hmrs']);
    const {air, device} = attachSwitch(rfd, {aes});
    return {rfd, receiver, air, device, descriptionDir};
}

/** The switch reports its channel state, CBC-signed with `counter` (or with a broken MIC). */
function report(rfd, device, state, counter, {badMic = false, key = KEY} = {}) {
    device.behaviour.channel(1).STATE = state ? 200 : 0;
    const telegram = cbcSign(key, device.statusTelegram(1), counter, {badMic});
    return rfd.module.sendEvent(telegram, {auth: EVENT_AUTH.NO_AUTH_REQUIRED});
}

/** Whether a STATE event with `value` arrives for the channel after receiver index `from`. */
async function arrives(receiver, value, from, timeout = 3000) {
    return waitForEvent(receiver, SW1, 'STATE', value, {from, timeout}).then(
        () => true,
        () => false,
    );
}

test(
    'CBC-MAC: signed events with a growing counter are accepted; a wrong MIC and a replayed counter are dropped (#4)',
    options(),
    async (t) => {
        const {rfd, receiver, air, device} = await setup();
        await withDaemon(rfd, async () => {
            await receiver.waitFor('newDevices', 15000);
            await pairDevice(rfd, receiver, air, device);
            assert.equal(await rfd.call('getValue', [SW0, 'AES_KEY']), 1, 'the key index after the key exchange');
            await rfd.call('putParamset', [SW1, 'MASTER', {AES_ACTIVE: true}]);
            await sleep(1500);

            let from = receiver.received.length;
            await report(rfd, device, true, 0x000105);
            const first = await arrives(receiver, true, from);
            from = receiver.received.length;
            await report(rfd, device, false, 0x000106);
            const second = await arrives(receiver, false, from);
            t.diagnostic(`valid MICs, counters 0x105 and 0x106: ${first} / ${second}`);
            await t.test('correctly signed events reach the receiver', regression(4), () => {
                assert.ok(first && second);
            });

            from = receiver.received.length;
            await report(rfd, device, true, 0x000107, {badMic: true});
            const badMic = await arrives(receiver, true, from);
            await t.test('a wrong MIC is dropped', regression(4), () => {
                assert.equal(badMic, false, 'the event with a wrong MIC reached the receiver');
                assert.ok(rfd.grep(/Data authentification failed/).length >= 1, 'rfd logged the failed check');
            });

            from = receiver.received.length;
            await report(rfd, device, true, 0x000106);
            const replay = await arrives(receiver, true, from);
            from = receiver.received.length;
            await report(rfd, device, true, 0x000100);
            const lower = await arrives(receiver, true, from);
            await t.test('a replayed or lower counter is dropped, even with a valid MIC', regression(4), () => {
                assert.equal(replay, false, 'the replayed counter 0x106 was accepted');
                assert.equal(lower, false, 'the lower counter 0x100 was accepted');
            });

            // a wrong MIC does not advance the counter: 0x107 with the right MIC still works
            from = receiver.received.length;
            await report(rfd, device, true, 0x000107);
            assert.ok(await arrives(receiver, true, from), 'the counter after the failed check');
            t.diagnostic(`STATE events: ${eventValues(receiver, SW1, 'STATE').join(' ')}`);
        }).finally(() => receiver.stop());
    },
);

test('CBC-MAC: the counter survives a restart (aes_cbc_cnt in the device file)', options(), async (t) => {
    const {rfd, receiver, air, device, descriptionDir} = await setup();
    let dir = null;
    let central = null;
    await withDaemon(rfd, async () => {
        await receiver.waitFor('newDevices', 15000);
        await pairDevice(rfd, receiver, air, device);
        await rfd.call('putParamset', [SW1, 'MASTER', {AES_ACTIVE: true}]);
        await sleep(1500);
        const from = receiver.received.length;
        await report(rfd, device, true, 0x002000);
        assert.ok(await arrives(receiver, true, from), 'the signed event before the restart');
        dir = rfd.workdir;
        central = device.central;
        await rfd.stopClean();
    }).finally(() => receiver.stop());

    const file = fs.readdirSync(path.join(dir, 'devices')).find((f) => f.includes(SWITCH_SERIAL));
    const xml = file ? fs.readFileSync(path.join(dir, 'devices', file), 'utf8') : '';
    const stored = /aes_cbc_cnt="(\d+)"/.exec(xml);
    t.diagnostic(`device file ${file}: aes_cbc_cnt ${stored ? stored[1] : 'missing'}`);
    assert.ok(stored, 'aes_cbc_cnt in the device file');
    assert.equal(Number(stored[1]), 0x002000);

    const again = await setup({dir, descriptionDir});
    await withDaemon(again.rfd, async () => {
        // the restarted rfd knows the device from its file; the new simulated switch is the same device (address,
        // key index 1) and was paired to the same central
        again.device.central = central;
        let from = again.receiver.received.length;
        await report(again.rfd, again.device, false, 0x001fff);
        const old = await arrives(again.receiver, false, from);
        from = again.receiver.received.length;
        await report(again.rfd, again.device, false, 0x002001);
        const fresh = await arrives(again.receiver, false, from);
        t.diagnostic(`after the restart: counter 0x1fff ${old}, 0x2001 ${fresh}`);
        assert.equal(old, false, 'a counter below the stored one was accepted after the restart');
        assert.ok(fresh, 'the next counter after the restart');
    }).finally(() => again.receiver.stop());
});

test(
    'CBC-MAC: a device with the default key (index 0) passes the check even with a wrong MIC, but its values count as not authenticated (rfd asks the device instead)',
    options(),
    async (t) => {
        // rfd with no user key (Current Index = 0): no key exchange at pairing, the device stays on index 0
        const dir = tmpdir('hmrs-rfd');
        fs.writeFileSync(path.join(dir, 'keys'), 'Current Index = 0\nLast Index = 0\n');
        const {rfd, receiver, air, device} = await setup({dir});
        await withDaemon(rfd, async () => {
            await receiver.waitFor('newDevices', 15000);
            await pairDevice(rfd, receiver, air, device);
            const keyIndex = await rfd.call('getValue', [SW0, 'AES_KEY']);
            t.diagnostic(`the key index of a switch paired while rfd has no user key: ${keyIndex}`);
            await rfd.call('putParamset', [SW1, 'MASTER', {AES_ACTIVE: true}]);
            await sleep(1500);
            const failedBefore = rfd.grep(/Data authentification failed/).length;
            await report(rfd, device, true, 0x000001, {badMic: true});
            await sleep(2000);
            const failed = rfd.grep(/Data authentification failed/).length - failedBefore;
            const violation = rfd.grep(/Scheduling get for AES violation .*:1\.STATE/).length;
            t.diagnostic(`failed checks: ${failed}; gets scheduled for an AES violation: ${violation}`);
            assert.equal(keyIndex, 0, 'the device is on the default key');
            // performCBCAuthentification returns true for key index 0 without looking at the MIC, but does not mark
            // the frame authenticated (SetAuthKey), so the channel's auth_violate_policy="get" applies: rfd does not
            // take the reported value and asks the device for its state instead
            assert.equal(failed, 0, 'the MIC was checked for a device on the default key');
            assert.ok(violation >= 1, 'rfd took the value of a frame that is not authenticated');
        }).finally(() => receiver.stop());
    },
);
