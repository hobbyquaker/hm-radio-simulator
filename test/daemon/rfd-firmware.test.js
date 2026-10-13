/**
 * Firmware update flows of rfd (the OTAU) with a simulated HM-LC-Sw2PBU-FM (rf_s_2conf_644.xml, `updatable="true"`)
 * behind the module on the pty: the firmware files rfd knows (`Firmware Dir/fwmap`, `User Firmware Dir/<dir>/info`),
 * `AVAILABLE_FIRMWARE`, `updateFirmware` with its bootloader start, the data-rate switch, the update frames and the
 * rebuild of the device, and every way it fails - the duty cycle (-8), the device out of range at 100 kbit/s (-9),
 * an update that stops half-way, a bootloader that does not start (`UPDATE_PENDING`, retried on the device's next
 * telegram), wrong files. The device's side is the simulator's bootloader personality (lib/device.js
 * BOOTLOADER_DEFAULTS, chosen to match rfd's own expectations, never read from a device firmware).
 *
 * Timing assumptions (rfd 3.89.11): the module's status for every sent telegram within defaultResponseTimeout =
 * 4000 ms (the air answers after ackDelayMs = 155 ms, a silent device after failDelayMs = 1106 ms, both measured;
 * a telegram without BIDI is "sent" after sendDelayMs = 30 ms, chosen); after the bootloader-start frame rfd waits
 * for the device's INFO_SERIAL and at most 1000 ms after its last response (BidcosFrameStartBootloader); an
 * unacknowledged update frame is sent four times in all (tryCount < 4) before -9 or "aborted"; the simulated device
 * restarts into its application rebootAfterMs = 300 ms (chosen) after the last frame. A whole update of three frames
 * is about twenty telegrams, a few seconds; every wait here has a margin of seconds.
 *
 * Not reachable with the simulated interfaces: fault -7 ("the interface is not able to carry an update") - rfd's
 * CCU2 and HMLGW2 interface types are both CCU2BidcosRemoteInterface, whose Updateable() is true; only the legacy
 * CCU and Lan Interface types refuse.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {startRfd, spawnRfd, withDaemon, skipWithoutDaemons, tmpdir} from '../helpers/daemon.js';
import {startReceiver} from '../helpers/rpc.js';
import {
    attachSwitch,
    attachUpdatableSwitch,
    pairDevice,
    waitForEvent,
    eventValues,
    SWITCH_SERIAL,
    UPDATABLE_SERIAL,
    UPDATABLE_TYPE_CODE,
} from '../helpers/switch.js';
import {buildUpdateFrames, encodeEq3, writeFwmapEntry, writeUserFirmware} from '../../lib/firmware.js';
import {regression} from '../helpers/known.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 300000, ...extra});
const CH0 = `${UPDATABLE_SERIAL}:0`;
const CH1 = `${UPDATABLE_SERIAL}:1`;
/** The firmware the file carries: 2.12 (byte 0x2c), up from the device's 2.9 (0x29). */
const NEW_VERSION = '2.12';
const NEW_BYTE = 0x2c;
const TYPE_DECIMAL = UPDATABLE_TYPE_CODE; // 257 in the fwmap

/** The three update frames of the test's firmware file. */
function frames(extra = {}) {
    return buildUpdateFrames({typeCode: UPDATABLE_TYPE_CODE, firmware: NEW_BYTE, frames: 3, size: 200, ...extra});
}

/**
 * rfd with the firmware file in place before it starts (the fwmap is read once, at start-up), a receiver and the
 * updatable switch on the air, not yet paired.
 */
async function setup(t, {device = {}, fwmap = true, frameSet = frames(), extra = '', methods = undefined} = {}) {
    const dir = tmpdir('hmrs-rfd');
    const firmwareDir = path.join(dir, 'firmware');
    if (fwmap) {
        writeFwmapEntry(firmwareDir, {typeCode: TYPE_DECIMAL, version: NEW_VERSION, frames: frameSet});
    }
    const rfd = await startRfd({dir, extra});
    const receiver = await startReceiver({methods});
    const {air, device: sw} = attachUpdatableSwitch(rfd, device);
    await rfd.call('init', [receiver.url, 'hmrs']);
    await receiver.waitFor('newDevices', 15000); // the central
    const cleanup = async () => {
        t.diagnostic(`trace: ${air.traceLines().join(' > ')}`);
        t.diagnostic(`module: ${rfd.module.commands.map((c) => c.name).join(' ')}`);
        await receiver.stop();
    };
    return {rfd, receiver, air, sw, dir, firmwareDir, cleanup};
}

/** A call that may fault: binrpc hands a fault back as an error or as the fault struct, depending on its version. */
async function faultOf(promise) {
    return promise.then(
        (result) =>
            result && typeof result === 'object' && 'faultCode' in result
                ? {code: result.faultCode, message: result.faultString}
                : {result},
        (error) => ({code: error.faultCode ?? error.code ?? null, message: error.faultString ?? error.message}),
    );
}

/** The names of the module's data-rate commands, in order. */
function dataRateCommands(rfd) {
    return rfd.module.commands.filter((c) => /DATARATE/.test(c.name)).map((c) => c.name);
}

async function updatedDescription(rfd, timeout = 20000) {
    const until = Date.now() + timeout;
    let last;
    while (Date.now() < until) {
        last = await rfd.call('getDeviceDescription', [UPDATABLE_SERIAL]);
        if (last.FIRMWARE === NEW_VERSION) {
            return last;
        }
        await sleep(250);
    }
    throw new Error(`FIRMWARE did not become ${NEW_VERSION}: ${JSON.stringify(last)}`);
}

test(
    'AVAILABLE_FIRMWARE and UPDATABLE: the fwmap names the file for the type; user firmware wins with the higher version',
    options(),
    async (t) => {
        const {rfd, receiver, air, sw, firmwareDir, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            // a second entry for the plain switch's type (17), whose description carries no updatable flag, plus the
            // lines InitFilenameMap skips: comments and the H/A/C prefixes
            writeFwmapEntry(firmwareDir, {
                typeCode: 17,
                version: '2.5',
                file: 'sw1.eq3',
                frames: frames(),
                extraLines: ['# a comment', 'HmIP-whatever x.eq3 1.0', '17 noext 9.9'],
            });
            await pairDevice(rfd, receiver, air, sw);
            const plain = attachSwitch(rfd).device;
            await pairDevice(rfd, receiver, air, plain);

            const d = await rfd.call('getDeviceDescription', [UPDATABLE_SERIAL]);
            assert.equal(d.FIRMWARE, '2.9');
            assert.equal(d.AVAILABLE_FIRMWARE, NEW_VERSION, 'from the fwmap, read at start-up');
            assert.equal(Boolean(d.UPDATABLE), true, 'the type carries updatable="true" (rfd sends the bool as 1)');
            const listed = (await rfd.call('listDevices')).find((x) => x.ADDRESS === UPDATABLE_SERIAL);
            assert.equal(listed.AVAILABLE_FIRMWARE, NEW_VERSION);
            const p = await rfd.call('getDeviceDescription', [SWITCH_SERIAL]);
            assert.equal(Boolean(p.UPDATABLE), false, 'rf_s.xml has no updatable flag');
            assert.ok(
                !('AVAILABLE_FIRMWARE' in p),
                `no AVAILABLE_FIRMWARE for a type that is not updatable: ${JSON.stringify(p)}`,
            );

            // user-deployed firmware: read on refreshDeployedDeviceFirmwareList, merged by version
            writeUserFirmware(firmwareDir, {name: 'newer', typeCode: TYPE_DECIMAL, version: '2.13', frames: frames()});
            writeUserFirmware(firmwareDir, {name: 'older', typeCode: TYPE_DECIMAL, version: '2.3', frames: frames()});
            writeUserFirmware(firmwareDir, {
                name: 'noversion',
                typeCode: TYPE_DECIMAL,
                version: '9.9',
                info: 'TypeCode=257\n',
            });
            writeUserFirmware(firmwareDir, {name: 'nofile', typeCode: 17, version: '9.9', frames: []});
            fs.unlinkSync(path.join(firmwareDir, 'nofile', 'nofile.eq3'));
            assert.equal(
                (await rfd.call('getDeviceDescription', [UPDATABLE_SERIAL])).AVAILABLE_FIRMWARE,
                NEW_VERSION,
                'nothing changes before the refresh',
            );
            await rfd.call('refreshDeployedDeviceFirmwareList', []);
            assert.equal((await rfd.call('getDeviceDescription', [UPDATABLE_SERIAL])).AVAILABLE_FIRMWARE, '2.13');
            assert.ok(!('AVAILABLE_FIRMWARE' in (await rfd.call('getDeviceDescription', [SWITCH_SERIAL]))));
            // an info file with spaces, a comment, a key it does not know and a value with surrounding blanks
            writeUserFirmware(firmwareDir, {
                name: 'spaced',
                typeCode: TYPE_DECIMAL,
                version: '2.14',
                frames: frames(),
                info: '  # comment\n  TypeCode = 257  \nColour=blue\nFirmwareVersion =  2.14 \n',
            });
            await rfd.call('refreshDeployedDeviceFirmwareList', []);
            assert.equal((await rfd.call('getDeviceDescription', [UPDATABLE_SERIAL])).AVAILABLE_FIRMWARE, '2.14');
            // the refresh does not re-read the fwmap
            writeFwmapEntry(firmwareDir, {typeCode: TYPE_DECIMAL, version: '3.0', file: 'later.eq3', frames: frames()});
            await rfd.call('refreshDeployedDeviceFirmwareList', []);
            assert.equal((await rfd.call('getDeviceDescription', [UPDATABLE_SERIAL])).AVAILABLE_FIRMWARE, '2.14');
        }).finally(cleanup);
    },
);

test(
    'the update: the bootloader starts, 100 kbit/s, the frames, 10 kbit/s, the device is rebuilt with the new firmware',
    options(),
    async (t) => {
        const set = frames();
        const {rfd, receiver, air, sw, dir, cleanup} = await setup(t, {frameSet: set});
        await withDaemon(rfd, async () => {
            await pairDevice(rfd, receiver, air, sw);
            const from = receiver.received.length;
            const commandsBefore = rfd.module.commands.length;
            const modes = [];
            sw.on('mode', (m) => modes.push(m));
            const started = Date.now();
            const result = await rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 120000});
            const took = Date.now() - started;
            t.diagnostic(`updateFirmware took ${took} ms`);
            assert.equal(result, true);

            // the device's side: the three frames, as rfd chunked and the bootloader reassembled them
            assert.equal(sw.updateFrames.length, 3, `rejected: ${JSON.stringify(sw.rejectedFrames)}`);
            set.forEach((frame, i) => assert.deepEqual(sw.updateFrames[i].subarray(2), frame, `frame ${i}`));
            assert.deepEqual(sw.rejectedFrames, []);
            await sleep(1000); // rebootAfterMs
            assert.equal(sw.mode, 'app', 'the device restarted into its application');
            assert.equal(sw.firmware, NEW_BYTE);
            assert.deepEqual(modes, ['bootloader', 'app']);

            // the module's side: 10k first (rfd makes sure), 100k for the frames, 10k at the end
            const rates = rfd.module.commands.slice(commandsBefore).filter((c) => /DATARATE/.test(c.name));
            assert.ok(rates.length >= 3, rates.map((c) => c.name).join(' '));
            assert.equal(rates.at(-1).name, 'SET_10K_DATARATE');
            assert.ok(rates.some((c) => c.name === 'SET_100K_DATARATE'));
            assert.equal(rfd.module.dataRate, 10);
            const trace = air.traceLines();
            const idx = (name) => trace.findIndex((l) => l === name);
            assert.ok(idx('tx START_BOOTLOADER [bidi]') >= 0, trace.join(' | '));
            assert.ok(
                idx('rx INFO_SERIAL [bcast]') > idx('tx START_BOOTLOADER [bidi]'),
                "the bootloader's announcement",
            );
            assert.ok(
                idx('tx WRITE_TRX_REG') > idx('rx INFO_SERIAL [bcast]'),
                'the register write at 10 kbit/s, no ACK asked',
            );
            assert.ok(idx('tx WRITE_TRX_REG [bidi] @100k') > idx('tx WRITE_TRX_REG'), 'then at 100 kbit/s with an ACK');
            const updates = trace.filter((l) => l.startsWith('tx FIRMWAREUPDATE'));
            assert.ok(
                updates.every((l) => l.endsWith('@100k')),
                'every update frame at 100 kbit/s',
            );
            assert.equal(updates.filter((l) => l.includes('[bidi]')).length, 3, 'one acknowledged chunk per frame');
            assert.ok(updates.length > 3, `${updates.length} chunks`);

            // rfd's side: the service flag went up and down, the device is a new one with the new firmware
            const bootloader = eventValues(receiver, CH0, 'DEVICE_IN_BOOTLOADER', from);
            assert.ok(bootloader.includes(true) && bootloader.at(-1) === false, JSON.stringify(bootloader));
            assert.equal(await rfd.call('getValue', [CH0, 'DEVICE_IN_BOOTLOADER']), false);
            assert.equal(await rfd.call('getValue', [CH0, 'UPDATE_PENDING']), false);
            const d = await rfd.call('getDeviceDescription', [UPDATABLE_SERIAL]);
            assert.equal(d.FIRMWARE, NEW_VERSION, 'Rebuild took the version from the fwmap');
            assert.equal(d.TYPE, 'HM-LC-Sw2PBU-FM');
            assert.equal(d.AVAILABLE_FIRMWARE, NEW_VERSION, 'rfd does not compare the versions');
            const again = receiver
                .calls('newDevices')
                .slice()
                .reverse()
                .find((c) => c.params[1].some((x) => x.ADDRESS === UPDATABLE_SERIAL));
            assert.ok(again && receiver.received.indexOf(again) >= from, 'newDevices again after the rebuild');
            assert.equal(again.params[1].find((x) => x.ADDRESS === UPDATABLE_SERIAL).FIRMWARE, NEW_VERSION);
            const dev = fs.readFileSync(path.join(dir, 'devices', `${UPDATABLE_SERIAL}.dev`), 'utf8');
            assert.ok(!/deviceInBootloader="true"/.test(dev), 'the device file no longer says bootloader');
            // the device still works
            await rfd.call('setValue', [CH1, 'STATE', true]);
            assert.equal(sw.behaviour.channel(1).STATE, 200);
            await waitForEvent(receiver, CH1, 'STATE', true, {from});
        }).finally(cleanup);
    },
);

test(
    'Call UpdateDevice On OTAU Device Rebuild: the rebuilt device is reported with updateDevice, not newDevices',
    options(),
    async (t) => {
        const methods = {
            'system.listMethods': () => [
                'system.listMethods',
                'system.multicall',
                'listDevices',
                'newDevices',
                'deleteDevices',
                'updateDevice',
                'event',
            ],
            updateDevice: () => '',
        };
        const {rfd, receiver, air, sw, cleanup} = await setup(t, {
            extra: 'Call UpdateDevice On OTAU Device Rebuild = true',
            methods,
        });
        await withDaemon(rfd, async () => {
            await pairDevice(rfd, receiver, air, sw);
            const from = receiver.received.length;
            assert.equal(await rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 120000}), true);
            await updatedDescription(rfd);
            const update = receiver.received.slice(from).find((r) => r.method === 'updateDevice');
            assert.ok(
                update,
                `updateDevice at the receiver: ${receiver.received
                    .slice(from)
                    .map((r) => r.method)
                    .join(' ')}`,
            );
            assert.equal(update.params[1], UPDATABLE_SERIAL);
            assert.equal(update.params[2], 0, 'UPDATE_HINT_ALL');
            assert.ok(
                !receiver.received
                    .slice(from)
                    .some((r) => r.method === 'newDevices' && r.params[1].some((x) => x.ADDRESS === UPDATABLE_SERIAL)),
                'no newDevices for the rebuilt device',
            );
        }).finally(cleanup);
    },
);

test('-8: the duty cycle leaves no room for the update; nothing is sent to the device', options(), async (t) => {
    const {rfd, receiver, air, sw, cleanup} = await setup(t);
    await withDaemon(rfd, async () => {
        await pairDevice(rfd, receiver, air, sw);
        // 90 %: DutyCycleForUpdate wants 450000 - 4500 * 90 = 45000 bytes to exceed the file plus 90000
        rfd.module.dutyCycle = 90;
        const before = air.trace.length;
        const fault = await faultOf(rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 60000}));
        assert.equal(fault.code, -8, JSON.stringify(fault));
        assert.match(fault.message, /DutyCycle/);
        assert.equal(air.trace.length, before, 'no telegram went out');
        assert.equal(sw.mode, 'app');
        assert.ok(!dataRateCommands(rfd).includes('SET_100K_DATARATE'));
        assert.equal(
            dataRateCommands(rfd).at(-1),
            'SET_10K_DATARATE',
            'rfd puts the interface to 10 kbit/s first and again on the error',
        );
        // every failed updateFirmware leaves the update pending (RFManager::UpdateFirmware catches the fault and
        // sets it): rfd runs it again on the device's next telegram
        assert.equal(await rfd.call('getValue', [CH0, 'UPDATE_PENDING']), true);
        // with the duty cycle gone the update goes through
        rfd.module.dutyCycle = 0;
        assert.equal(await rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 120000}), true);
        await updatedDescription(rfd);
        assert.equal(await rfd.call('getValue', [CH0, 'UPDATE_PENDING']), false);
    }).finally(cleanup);
});

test(
    '-9: the device is out of range at 100 kbit/s - four tries, then "out of range"; back in range, the update resumes without a restart',
    options(),
    async (t) => {
        const {rfd, receiver, air, sw, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            await pairDevice(rfd, receiver, air, sw);
            const from = receiver.received.length;
            // it hears the start and the register write, is at 100 kbit/s - and then out of range
            const vanish = (e) => {
                if (e.dir === 'tx' && e.name === 'WRITE_TRX_REG [bidi] @100k') {
                    air.setRssi(sw, rfd.module, null);
                    air.off('trace', vanish);
                }
            };
            air.on('trace', vanish);
            const started = Date.now();
            const fault = await faultOf(rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 120000}));
            t.diagnostic(`-9 after ${Date.now() - started} ms`);
            assert.equal(fault.code, -9, JSON.stringify(fault));
            assert.match(fault.message, /out of range/);
            assert.equal(sw.mode, 'bootloader');
            assert.equal(sw.dataRate, 100);
            assert.equal(sw.updateFrames.length, 0);
            // the first frame went out four times (every chunk again each time), unanswered
            const tries = air.traceLines().filter((l) => l === 'tx FIRMWAREUPDATE [bidi] @100k');
            assert.equal(tries.length, 4, air.traceLines().join(' | '));
            assert.equal(rfd.module.dataRate, 10, 'the interface is back at 10 kbit/s');
            assert.equal(dataRateCommands(rfd).at(-1), 'SET_10K_DATARATE');
            // rfd knows the device sits in its bootloader, and the update stays pending
            assert.equal(await rfd.call('getValue', [CH0, 'DEVICE_IN_BOOTLOADER']), true);
            assert.ok(eventValues(receiver, CH0, 'DEVICE_IN_BOOTLOADER', from).includes(true));
            assert.equal(await rfd.call('getValue', [CH0, 'UPDATE_PENDING']), true);

            // back in range: rfd skips the bootloader start (DEVICE_IN_BOOTLOADER) and the device, still in its
            // bootloader at 100 kbit/s, misses the first register write at 10 kbit/s (no ACK asked) and takes the
            // second at 100 kbit/s and the frames
            air.setRssi(sw, rfd.module, -60);
            const before = air.trace.length;
            assert.equal(await rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 120000}), true);
            assert.ok(!air.traceLines().slice(before).includes('tx START_BOOTLOADER [bidi]'), 'no second start');
            assert.equal(sw.updateFrames.length, 3);
            await updatedDescription(rfd);
            assert.equal(await rfd.call('getValue', [CH0, 'DEVICE_IN_BOOTLOADER']), false);
            assert.equal(await rfd.call('getValue', [CH0, 'UPDATE_PENDING']), false);
        }).finally(cleanup);
    },
);

test(
    'out of range right after the bootloader start: "Unable to set datarate to 100k" after three tries',
    options(),
    async (t) => {
        const {rfd, receiver, air, sw, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            await pairDevice(rfd, receiver, air, sw);
            sw.once('mode', () => air.setRssi(sw, rfd.module, null));
            const fault = await faultOf(rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 120000}));
            assert.match(fault.message, /Unable to set datarate to 100k/, JSON.stringify(fault));
            assert.equal(fault.code, -1);
            assert.equal(sw.mode, 'bootloader');
            // set100kDataRate: three rounds of 10k register write, SET_100K, 100k register write with an ACK
            assert.equal(
                air.traceLines().filter((l) => l === 'tx WRITE_TRX_REG [bidi] @100k').length,
                3,
                air.traceLines().join(' | '),
            );
            assert.equal(rfd.module.commands.filter((c) => c.name === 'SET_100K_DATARATE').length, 3);
            assert.equal(rfd.module.dataRate, 10);
            assert.equal(await rfd.call('getValue', [CH0, 'UPDATE_PENDING']), true);
        }).finally(cleanup);
    },
);

test(
    'an update that stops half-way: a later frame stays unacknowledged - "Firmware update aborted"',
    options(),
    async (t) => {
        const {rfd, receiver, air, sw, cleanup} = await setup(t, {device: {bootloader: {silentFrom: 1}}});
        await withDaemon(rfd, async () => {
            await pairDevice(rfd, receiver, air, sw);
            const fault = await faultOf(rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 120000}));
            assert.match(fault.message, /Firmware update aborted/, JSON.stringify(fault));
            assert.equal(fault.code, -1, 'no code of its own');
            // frame 0 acknowledged, frame 1 sent four times in all, never answered
            assert.equal(sw.updateFrames.length, 1, `frames the device took: ${sw.updateFrames.length}`);
            const bidi = air.traceLines().filter((l) => l === 'tx FIRMWAREUPDATE [bidi] @100k');
            assert.equal(bidi.length, 5, air.traceLines().join(' | '));
            assert.equal(sw.mode, 'bootloader', 'the device waits for the rest');
            assert.equal(rfd.module.dataRate, 10);
            assert.equal((await rfd.call('getDeviceDescription', [UPDATABLE_SERIAL])).FIRMWARE, '2.9', 'not rebuilt');
            assert.equal(await rfd.call('getValue', [CH0, 'DEVICE_IN_BOOTLOADER']), true);
            assert.equal(await rfd.call('getValue', [CH0, 'UPDATE_PENDING']), true);
        }).finally(cleanup);
    },
);

test(
    'the bootloader does not start (the device is away): "didn\'t start", UPDATE_PENDING, the update runs on the device\'s next telegram',
    options(),
    async (t) => {
        const {rfd, receiver, air, sw, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            await pairDevice(rfd, receiver, air, sw);
            const from = receiver.received.length;
            sw.answering = false;
            const fault = await faultOf(rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 60000}));
            assert.match(fault.message, /didn't start/, JSON.stringify(fault));
            assert.equal(await rfd.call('getValue', [CH0, 'UPDATE_PENDING']), true);
            await waitForEvent(receiver, CH0, 'UPDATE_PENDING', true, {from});
            assert.equal(sw.mode, 'app');
            assert.equal(rfd.module.dataRate, 10);
            // the failed start is sent through the concentrator, not RFDevice::SendFrame: no UNREACH from it
            assert.equal(await rfd.call('getValue', [CH0, 'UNREACH']), false);

            // the device is back and sends a status report: rfd runs the pending update from its main loop
            sw.answering = true;
            await sleep(5500); // FAIL_COUNTER_RESET_TIME: rfd refuses sends to the device for 5 s after a failure
            air.reportStatus(sw, 1);
            await updatedDescription(rfd, 60000);
            assert.equal(await rfd.call('getValue', [CH0, 'UPDATE_PENDING']), false);
            await waitForEvent(receiver, CH0, 'UPDATE_PENDING', false, {from});
            assert.equal(sw.updateFrames.length, 3);
            await sleep(1000);
            assert.equal(sw.firmware, NEW_BYTE);
        }).finally(cleanup);
    },
);

test('the bootloader refuses to start (NACK): the same pending update', options(), async (t) => {
    const {rfd, receiver, air, sw, cleanup} = await setup(t, {device: {bootloader: {startsOnCommand: false}}});
    await withDaemon(rfd, async () => {
        await pairDevice(rfd, receiver, air, sw);
        const fault = await faultOf(rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 60000}));
        assert.match(fault.message, /didn't start/, JSON.stringify(fault));
        assert.equal(await rfd.call('getValue', [CH0, 'UPDATE_PENDING']), true);
        assert.equal(sw.mode, 'app');
        sw.bootloader.startsOnCommand = true;
        air.reportStatus(sw, 1);
        await updatedDescription(rfd, 60000);
        assert.equal(await rfd.call('getValue', [CH0, 'UPDATE_PENDING']), false);
    }).finally(cleanup);
});

test('wrong files: a missing file, a file cut short, no entry for the type', options(), async (t) => {
    const {rfd, receiver, air, sw, firmwareDir, cleanup} = await setup(t, {fwmap: false});
    await withDaemon(rfd, async () => {
        // the fwmap is read at start-up: without one, rfd logged the missing file and knows no firmware
        assert.ok(rfd.grep(/unable to open file .*fwmap/).length >= 1, rfd.tail(10));
        await pairDevice(rfd, receiver, air, sw);
        const d = await rfd.call('getDeviceDescription', [UPDATABLE_SERIAL]);
        assert.ok(!('AVAILABLE_FIRMWARE' in d));
        let fault = await faultOf(rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 60000}));
        assert.match(fault.message, /Unable to load updatefile/, JSON.stringify(fault));
        assert.ok(rfd.grep(/No update file for type 257/).length >= 1);
        assert.equal(sw.mode, 'app', 'the device was not touched');

        // the user firmware dir names a file that is not there (refreshed at run time)
        writeUserFirmware(firmwareDir, {name: 'gone', typeCode: TYPE_DECIMAL, version: NEW_VERSION, frames: frames()});
        fs.unlinkSync(path.join(firmwareDir, 'gone', 'gone.eq3'));
        await rfd.call('refreshDeployedDeviceFirmwareList', []);
        assert.ok(
            !('AVAILABLE_FIRMWARE' in (await rfd.call('getDeviceDescription', [UPDATABLE_SERIAL]))),
            'a dir without .eq3 is no entry',
        );
        // ... and one whose file is cut short in the middle of a frame
        const cut = writeUserFirmware(firmwareDir, {
            name: 'short',
            typeCode: TYPE_DECIMAL,
            version: NEW_VERSION,
            frames: frames(),
        });
        const text = fs.readFileSync(path.join(cut, 'short.eq3'), 'utf8');
        fs.writeFileSync(path.join(cut, 'short.eq3'), text.slice(0, text.length - 30));
        await rfd.call('refreshDeployedDeviceFirmwareList', []);
        assert.equal((await rfd.call('getDeviceDescription', [UPDATABLE_SERIAL])).AVAILABLE_FIRMWARE, NEW_VERSION);
        fault = await faultOf(rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 60000}));
        assert.match(fault.message, /Unable to load updatefile/, JSON.stringify(fault));
        assert.ok(rfd.grep(/Error reading update file for type 257/).length >= 1);
        assert.equal(sw.mode, 'app');
        assert.equal(rfd.module.dataRate, 10);
        // a whole file again: the update goes through
        fs.writeFileSync(path.join(cut, 'short.eq3'), encodeEq3(frames()));
        assert.equal(await rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 120000}), true);
        await updatedDescription(rfd);
    }).finally(cleanup);
});

test(
    'a file the device refuses (another type, a bad CRC): the NACK is not an acknowledgement (update-nack-ignored)',
    options(),
    async (t) => {
        const {rfd, receiver, air, sw, firmwareDir, cleanup} = await setup(t, {fwmap: false});
        await withDaemon(rfd, async () => {
            await pairDevice(rfd, receiver, air, sw);
            // the file of another device type: the simulated bootloader checks frame 0 and answers NACK
            writeUserFirmware(firmwareDir, {
                name: 'other',
                typeCode: TYPE_DECIMAL,
                version: NEW_VERSION,
                frames: buildUpdateFrames({typeCode: 0x0011, firmware: NEW_BYTE, frames: 2, size: 100}),
            });
            await rfd.call('refreshDeployedDeviceFirmwareList', []);
            const fault = await faultOf(rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 120000}));
            t.diagnostic(`another type: ${JSON.stringify(fault)}; rejected ${JSON.stringify(sw.rejectedFrames)}`);
            assert.equal(sw.rejectedFrames[0]?.reason, 'type');
            await t.test(
                'a NACKed first frame ends the update as "out of range" (-9), not as a success',
                regression('update-nack-ignored'),
                () => {
                    assert.equal(fault.code, -9, JSON.stringify(fault));
                    assert.notEqual(fault.result, true, 'rfd reported the update as done');
                },
            );
            await sleep(1000);
            const d = await rfd.call('getDeviceDescription', [UPDATABLE_SERIAL]);
            t.diagnostic(
                `after the refused file: FIRMWARE ${d.FIRMWARE}, device mode ${sw.mode}, firmware ${sw.firmware.toString(16)}`,
            );
            await t.test('the device is not rebuilt after a refused file', regression('update-nack-ignored'), () => {
                assert.equal(d.FIRMWARE, '2.9');
            });
            // the right type, but frame 1 does not check: refused as well (the device is power-cycled first: it
            // sat in its bootloader at 100 kbit/s, where rfd's bootloader start at 10 kbit/s would not reach it)
            sw.leaveBootloader();
            const spoiled = frames();
            spoiled[1][20] ^= 0xff;
            writeUserFirmware(firmwareDir, {name: 'crc', typeCode: TYPE_DECIMAL, version: '2.15', frames: spoiled});
            await rfd.call('refreshDeployedDeviceFirmwareList', []);
            sw.rejectedFrames.length = 0;
            const again = await faultOf(rfd.call('updateFirmware', [UPDATABLE_SERIAL], {timeout: 120000}));
            t.diagnostic(`bad CRC: ${JSON.stringify(again)}; rejected ${JSON.stringify(sw.rejectedFrames)}`);
            assert.ok(
                sw.rejectedFrames.some((r) => r.reason === 'crc'),
                JSON.stringify(sw.rejectedFrames),
            );
            await t.test(
                'a NACKed later frame ends the update as "aborted", not as a success',
                regression('update-nack-ignored'),
                () => {
                    assert.match(again.message || '', /Firmware update aborted/);
                },
            );
        }).finally(cleanup);
    },
);

test(
    'a user firmware info file with a blank line: rfd starts and reads the rest (info-blank-line)',
    options(),
    async (t) => {
        const dir = tmpdir('hmrs-rfd');
        const firmwareDir = path.join(dir, 'firmware');
        writeFwmapEntry(firmwareDir, {typeCode: TYPE_DECIMAL, version: NEW_VERSION, frames: frames()});
        writeUserFirmware(firmwareDir, {
            name: 'blank',
            typeCode: TYPE_DECIMAL,
            version: '2.13',
            frames: frames(),
            info: 'TypeCode=257\n\nFirmwareVersion=2.13\n',
        });
        const rfd = await spawnRfd({dir});
        let ready = true;
        try {
            await rfd.waitReady();
        } catch (error) {
            ready = false;
            t.diagnostic(`rfd: ${error.message.split('\n')[0]}`);
        }
        try {
            t.diagnostic(
                `rfd exit: ${JSON.stringify(rfd.exit)}; log: ${rfd.grep(/terminate|out_of_range|what\(\)/).join(' | ')}`,
            );
            await t.test('rfd survives the blank line', regression('info-blank-line'), () => {
                assert.ok(ready && rfd.alive, `rfd did not come up: ${JSON.stringify(rfd.exit)}`);
            });
            if (ready) {
                const receiver = await startReceiver();
                try {
                    const {air, device: sw} = attachUpdatableSwitch(rfd);
                    await rfd.call('init', [receiver.url, 'hmrs']);
                    await pairDevice(rfd, receiver, air, sw);
                    assert.equal(
                        (await rfd.call('getDeviceDescription', [UPDATABLE_SERIAL])).AVAILABLE_FIRMWARE,
                        '2.13',
                    );
                } finally {
                    await receiver.stop();
                }
            }
        } finally {
            await rfd.stop();
        }
    },
);
