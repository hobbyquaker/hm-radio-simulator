/**
 * The firmware update of a wired device through hs485d (the Hexfile path): `Firmware Dir/fwmap` names an Intel HEX
 * file per device type (`H<type>V<hw>`), with the version as a literal or as `@<address>` of the version word in the
 * image; `AVAILABLE_FIRMWARE` comes from it; `updateFirmware` puts the bus to sleep (`z`), switches the device into
 * its bootloader (`u`), asks the page size (`p`), writes the pages (`w`), reads them back (`r`), starts the
 * application (`g`), wakes the bus (`Z`) and rebuilds the device from a fresh `h`/`v`. The device's side is the
 * simulated bootloader of lib/wired.js (WIRED_BOOTLOADER_DEFAULTS, chosen to answer what hs485d sends, never read
 * from a device firmware).
 *
 * Timing assumptions (hs485d 3.89.11): the gateway's answer to a command within HS485_RESPONSE_TIMEOUT = 700 ms (the
 * simulated bus answers in 45 ms, measured); hs485d sleeps 1 s between the application's `u` and the bootloader's
 * (HS485Device::UpdateFirmware); BroadcastSleepMode sends `z`/`Z` twice, 100 ms apart; a silent device is reported
 * by the gateway after 620 ms (measured) and hs485d tries twice (maxRetries = 2). A 1 KiB image in 128-byte pages is
 * 8 writes and 8 reads: the whole update takes about three seconds; every wait here has a margin of seconds.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {startHs485d, withDaemon, skipWithoutDaemons, HS485TYPES, tmpdir} from '../helpers/daemon.js';
import {startReceiver} from '../helpers/rpc.js';
import {loadDeviceDescription} from '../../lib/rftypes.js';
import {WiredBus, WiredDevice} from '../../lib/wired.js';
import {buildWiredImage, encodeIntelHex, writeWiredFwmapEntry} from '../../lib/firmware.js';
import {regression, isKnownBroken} from '../helpers/known.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 240000, ...extra});
const SERIAL = 'SIMW000001';
const ADDRESS = 0x00004711;
const TYPE = 'HMW-LC-Sw2-DR';
const SYSINFO = [0x11, 0x00, 0x03, 0x05]; // type 17, hardware 0, firmware 3.05
const KEY = 'H17V0'; // how hs485d names the type in the fwmap (HS485Device::GetAvailableFirmware)
const VERSION_ADDRESS = 0x3fe;
const IMAGE = buildWiredImage({size: 1024, version: [3, 6], versionAddress: VERSION_ADDRESS});
const CH0 = `${SERIAL}:0`;
// the type the rebuild of the #257 test finds (hmw_lc_bl1_dr.xml)
const OTHER_TYPE = 'HMW-LC-Bl1-DR';
const OTHER_TYPE_BYTE = 0x15;

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
        bootloader: {pageSize: 128, flashSize: 0x8000, versionAddress: VERSION_ADDRESS},
        ...options,
    });
}

/**
 * hs485d through the gateway with the device on the bus and the firmware file in place before it starts (the fwmap is
 * read once, at start-up); a receiver registered; the device discovered.
 */
async function setup(t, {device = makeSwitch(), version = '3.06', hex = encodeIntelHex(IMAGE), fwmap = true} = {}) {
    const dir = tmpdir('hmrs-hs485d');
    const firmwareDir = path.join(dir, 'firmware');
    fs.mkdirSync(firmwareDir, {recursive: true});
    if (fwmap) {
        writeWiredFwmapEntry(firmwareDir, {key: KEY, version, text: hex});
    }
    const bus = new WiredBus();
    bus.add(device);
    const hs485d = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus, dir});
    const receiver = await startReceiver();
    await hs485d.call('init', [receiver.url, 'hmrs', false]);
    const lgw = hs485d.lgw;
    const cleanup = async () => {
        t.diagnostic(`bus: ${bus.traceLines().join(' > ')}`);
        t.diagnostic(`bootloader: ${device.bootCommands.join(' ')}`);
        t.diagnostic(`gateway: ${lgw.commandLines().join(' ')}`);
        await receiver.stop();
    };
    const from = receiver.received.length;
    const count = await hs485d.call('searchDevices', [], {timeout: 60000});
    assert.equal(count, 1, 'the device is found');
    await waitForNewDevices(receiver, from, SERIAL);
    return {hs485d, receiver, bus, device, dir, firmwareDir, cleanup};
}

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
            .map((r) => r.method)
            .join(' ')}`,
    );
}

/** The result of updateFirmware, or the fault as {fault}. */
async function updateResult(hs485d, timeout = 60000) {
    return hs485d.call('updateFirmware', [SERIAL], {timeout}).then(
        (result) => (result && typeof result === 'object' && 'faultCode' in result ? {fault: result} : {result}),
        (error) => ({fault: {faultCode: error.faultCode ?? error.code ?? null, faultString: error.message}}),
    );
}

test(
    'AVAILABLE_FIRMWARE from the fwmap: a literal version, and the version word read from the hex (@address)',
    options(),
    async (t) => {
        const first = await setup(t);
        await withDaemon(first.hs485d, async () => {
            const d = await first.hs485d.call('getDeviceDescription', [SERIAL]);
            assert.equal(d.FIRMWARE, '3.05');
            assert.equal(d.AVAILABLE_FIRMWARE, '3.06', 'the literal from the fwmap, printed as %d.%02d');
            const listed = (await first.hs485d.call('listDevices')).find((x) => x.ADDRESS === SERIAL);
            assert.equal(listed.AVAILABLE_FIRMWARE, '3.06');
        }).finally(first.cleanup);

        // @0x3fe: the little-endian version word in the image (minor, major) - read when the device is first described
        const second = await setup(t, {version: `@0x${VERSION_ADDRESS.toString(16)}`});
        await withDaemon(second.hs485d, async () => {
            const d = await second.hs485d.call('getDeviceDescription', [SERIAL]);
            assert.equal(d.AVAILABLE_FIRMWARE, '3.06', 'from the hex file');
            assert.ok(second.hs485d.grep(/Lade Firmwaredatei|Could not read firmware/).length === 0, 'no complaint');
        }).finally(second.cleanup);

        // a fwmap whose file name has no .hex, and a type nobody has: no AVAILABLE_FIRMWARE at all
        const third = await setup(t, {fwmap: false});
        await withDaemon(third.hs485d, async () => {
            fs.writeFileSync(path.join(third.firmwareDir, 'fwmap'), 'H17V0 noext 3.06\nH99V0 other.hex 1.00\n');
            const d = await third.hs485d.call('getDeviceDescription', [SERIAL]);
            assert.ok(!('AVAILABLE_FIRMWARE' in d), JSON.stringify(d));
            const {result, fault} = await updateResult(third.hs485d);
            assert.equal(fault, undefined, JSON.stringify(fault));
            assert.deepEqual(result, [false], 'no firmware for the type: false, nothing sent');
            assert.ok(third.hs485d.grep(/No firmware found for updating/).length >= 1, third.hs485d.tail(10));
            assert.deepEqual(third.device.bootCommands, []);
        }).finally(third.cleanup);
    },
);

test(
    'the update: sleep mode, u, the page size, the pages written and verified, g, the device rebuilt with the new version',
    options(),
    async (t) => {
        const {hs485d, receiver, bus, device, cleanup} = await setup(t);
        await withDaemon(hs485d, async () => {
            const from = receiver.received.length;
            const busFrom = bus.trace.length;
            const started = Date.now();
            const {result, fault} = await updateResult(hs485d);
            t.diagnostic(`updateFirmware took ${Date.now() - started} ms`);
            assert.equal(fault, undefined, JSON.stringify(fault));
            assert.deepEqual(result, [true]);

            // the device's side
            const commands = device.bootCommands;
            assert.deepEqual(commands.slice(0, 3), ['u', 'u', 'p'], commands.join(' '));
            const writes = commands.filter((c) => c.startsWith('w@'));
            const reads = commands.filter((c) => c.startsWith('r@'));
            assert.equal(writes.length, 8, '1 KiB in 128-byte pages');
            assert.equal(reads.length, 8);
            assert.equal(
                commands.filter((c) => c === 'p').length,
                2,
                'the page size asked before the write and before the verify',
            );
            assert.equal(commands.at(-1), 'g');
            assert.ok(commands.indexOf('r@0000') > commands.indexOf('w@0380'), 'all writes before the reads');
            assert.deepEqual(device.flash.subarray(0, IMAGE.length), IMAGE, 'the flash holds the image');
            assert.ok(device.flash.subarray(IMAGE.length).every((b) => b === 0xff));
            assert.equal(device.mode, 'app');
            assert.deepEqual([...device.sysinfo], [0x11, 0x00, 0x03, 0x06], 'the application reports the new version');
            // the bus: z twice before, Z twice after
            const names = bus.traceLines().slice(busFrom);
            assert.deepEqual(names.slice(0, 2), ["tx 'z'", "tx 'z'"], names.join(' | '));
            assert.deepEqual(names.slice(-4, -2), ["tx 'Z'", "tx 'Z'"], names.join(' | '));
            assert.deepEqual(names.slice(-2), ["tx 'h'", "tx 'v'"], 'the rebuild asks the type and version again');

            // hs485d's side
            const d = await hs485d.call('getDeviceDescription', [SERIAL]);
            assert.equal(d.FIRMWARE, '3.06');
            assert.equal(d.TYPE, TYPE);
            const again = await waitForNewDevices(receiver, from, SERIAL);
            assert.equal(
                again.params[1].find((x) => x.ADDRESS === SERIAL).FIRMWARE,
                '3.06',
                'newDevices with the new version',
            );
            assert.equal(await hs485d.call('getValue', [CH0, 'UNREACH']), false);
            // the device still works
            await hs485d.call('setValue', [`${SERIAL}:3`, 'STATE', true]);
            assert.equal(device.behaviour.channel(2).STATE, 200);
        }).finally(cleanup);
    },
);

test(
    '#257: an update that changes the device type, then a failed send: no event on a deleted maintenance channel',
    options(regression(257)),
    async (t) => {
        // HS485Device::Rebuild deletes the channels when the type changes; before #257 the maintenance channel stayed
        // registered for the device's internal value events, so the next UNREACH called OnEvent() on freed memory. The
        // device comes from its file (a restart), which gives the maintenance channel its class on every ref. The new
        // type is chosen: the simulated image only changes the version, so the type byte is set by hand for the `h` of
        // the rebuild.
        const device = makeSwitch();
        const {hs485d, receiver, bus, dir, cleanup} = await setup(t, {device});
        await hs485d.stop();
        await receiver.stop();
        const second = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus, dir});
        await withDaemon(second, async () => {
            device.sysinfo[0] = OTHER_TYPE_BYTE;
            const {fault} = await updateResult(second);
            t.diagnostic(`update: ${JSON.stringify(fault || 'ok')}`);
            assert.equal((await second.call('getDeviceDescription', [SERIAL])).TYPE, OTHER_TYPE, 'the type changed');
            device.answering = false;
            // a write that fails sets UNREACH (two tries, 620 ms each, measured; the wait has a margin of seconds)
            await second
                .call('putParamset', [SERIAL, 'MASTER', {LOGGING_TIME: {explicitDouble: 4.0}}], {timeout: 30000})
                .catch(() => null);
            let unreach = false;
            for (let i = 0; i < 40 && !unreach && second.alive; i++) {
                await sleep(500);
                unreach = await second.call('getValue', [CH0, 'UNREACH']).catch(() => false);
            }
            assert.ok(second.alive, `hs485d lives: ${JSON.stringify(second.exit)}`);
            // a rebuilt channel carries its maintenance class only with #209 (the wired-maintenance finding), which came
            // after #257; the point of #257 is that nothing touches the deleted channel
            if (!isKnownBroken('wired-maintenance')) {
                assert.equal(unreach, true, 'the new channel has the failure');
            }
            assert.deepEqual(second.sanitizerReports(), []);
        }).finally(cleanup);
    },
);

test(
    'a verify mismatch: the write spoils a byte, the read-back differs, hs485d reports false and does not rebuild',
    options(),
    async (t) => {
        const {hs485d, receiver, device, cleanup} = await setup(t, {
            device: makeSwitch({
                bootloader: {pageSize: 128, flashSize: 0x8000, versionAddress: VERSION_ADDRESS, corruptWriteAt: 0x205},
            }),
        });
        await withDaemon(hs485d, async () => {
            const from = receiver.received.length;
            const {result, fault} = await updateResult(hs485d);
            assert.equal(fault, undefined, JSON.stringify(fault));
            assert.deepEqual(result, [false]);
            assert.ok(hs485d.grep(/Verify error @ 0x0205/).length >= 1, hs485d.tail(10));
            assert.equal(device.bootCommands.at(-1), 'g', 'the application is started all the same');
            assert.equal(
                device.bootCommands.filter((c) => c.startsWith('r@')).length,
                5,
                'the verify stops at the bad page',
            );
            assert.equal((await hs485d.call('getDeviceDescription', [SERIAL])).FIRMWARE, '3.05', 'not rebuilt');
            await sleep(1000);
            assert.ok(!receiver.received.slice(from).some((r) => r.method === 'newDevices'), 'no newDevices');
        }).finally(cleanup);
    },
);

test(
    'the device does not enter its bootloader: the bootloader frames go unanswered, hs485d reports false',
    options(),
    async (t) => {
        const {hs485d, device, cleanup} = await setup(t, {device: makeSwitch({bootloader: {entersOnCommand: false}})});
        await withDaemon(hs485d, async () => {
            const started = Date.now();
            const {result, fault} = await updateResult(hs485d);
            t.diagnostic(`false after ${Date.now() - started} ms`);
            assert.equal(fault, undefined, JSON.stringify(fault));
            assert.deepEqual(result, [false]);
            assert.equal(device.mode, 'app');
            assert.deepEqual(device.bootCommands, []);
            assert.ok(
                device.flash.every((b) => b === 0xff),
                'nothing written',
            );
            assert.ok(hs485d.grep(/Error sending message/).length >= 1, hs485d.tail(10));
            assert.equal((await hs485d.call('getDeviceDescription', [SERIAL])).FIRMWARE, '3.05');
        }).finally(cleanup);
    },
);

test(
    'a bootloader that answers a page size of 0: hs485d reports false and lives (bootloader-pagesize-zero)',
    options(),
    async (t) => {
        const {hs485d, device, cleanup} = await setup(t, {
            device: makeSwitch({bootloader: {pageSizeAnswer: [0, 0], versionAddress: VERSION_ADDRESS}}),
        });
        await withDaemon(hs485d, async () => {
            // a short timeout: when hs485d dies the call is never answered
            const outcome = await updateResult(hs485d, 15000);
            await sleep(500);
            t.diagnostic(
                `outcome ${JSON.stringify(outcome)}; hs485d ${hs485d.alive ? 'alive' : `gone ${JSON.stringify(hs485d.exit)}`}`,
            );
            await t.test('hs485d survives the answer', regression('bootloader-pagesize-zero'), () => {
                assert.ok(hs485d.alive, `hs485d exited: ${JSON.stringify(hs485d.exit)}`);
                assert.deepEqual(outcome.result, [false]);
            });
            assert.deepEqual(device.bootCommands.slice(0, 3), ['u', 'u', 'p']);
        }).finally(cleanup);
    },
);

test(
    'hex files with a checksum error and with a record type hs485d does not know: loaded with a warning',
    options(),
    async (t) => {
        const hex = encodeIntelHex(IMAGE, {breakChecksumAt: 3, extraRecords: [':020000040000FA']});
        const {hs485d, device, cleanup} = await setup(t, {version: `@0x${VERSION_ADDRESS.toString(16)}`, hex});
        await withDaemon(hs485d, async () => {
            const d = await hs485d.call('getDeviceDescription', [SERIAL]);
            assert.equal(d.AVAILABLE_FIRMWARE, '3.06', 'the file is read to the end');
            assert.ok(hs485d.grep(/Hex record checksum error/).length >= 1, hs485d.tail(20));
            assert.ok(hs485d.grep(/Record type 0x4 not supported/).length >= 1, hs485d.tail(20));
            const {result} = await updateResult(hs485d);
            assert.deepEqual(result, [true], 'the data records are what counts');
            assert.deepEqual(device.flash.subarray(0, IMAGE.length), IMAGE);
        }).finally(cleanup);
    },
);
