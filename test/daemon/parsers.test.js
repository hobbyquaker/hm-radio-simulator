/**
 * What the daemons parse beyond the RPC layer, driven through the daemons themselves (the libFuzzer harnesses in
 * fuzz/ take the same parsers apart in isolation):
 *   - telegrams from a **paired** device's address with mutated content: they pass the address check and reach
 *     RFDevice::ProcessIncomingFrame, the frame descriptions and the conversions (random telegrams from unknown
 *     addresses, rfd-pty-module.test.js, are dropped before that);
 *   - a JSON value for a parameter with write dependencies (HM-LC-RGBW-WM's USER_COLOR: JSONObject, the finding
 *     json-substr);
 *   - a wired firmware file without a data record (Hexfile, the finding hexfile-no-data);
 *   - a configuration line longer than 255 characters (PropertyMap, the finding propertymap-long-line);
 *   - a directory named `X.dev` and an empty `.dev` in hs485d's device directory (OpenCCU-Base #29 made parseFile()
 *     check seek, size and read; rfd's side is in restart-config.test.js).
 *
 * Timing assumptions (rfd 3.89.11): a sent telegram's status within defaultResponseTimeout = 4000 ms (the simulated
 * module acknowledges after ackDelayMs = 155 ms, measured); the event gap of the air is 20 ms (chosen). Margins of
 * seconds.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    startRfd,
    spawnRfd,
    startHs485d,
    withDaemon,
    skipWithoutDaemons,
    tmpdir,
    HS485TYPES,
} from '../helpers/daemon.js';
import {startReceiver} from '../helpers/rpc.js';
import {attachSwitch, pairDevice, description, SWITCH_SERIAL, SWITCH_ADDRESS} from '../helpers/switch.js';
import {regression} from '../helpers/known.js';
import {BidcosDevice} from '../../lib/device.js';
import {encodeTelegram, CTRL} from '../../lib/telegram.js';
import {mulberry32, seedFromEnvironment} from '../../lib/prng.js';
import {loadDeviceDescription} from '../../lib/rftypes.js';
import {WiredBus, WiredDevice} from '../../lib/wired.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 240000, ...extra});
const RGBW_SERIAL = 'SIMRGBW001';
const RGBW_ADDRESS = 0x789abc;

async function rfdWithReceiver() {
    const rfd = await startRfd();
    const receiver = await startReceiver();
    await rfd.call('init', [receiver.url, 'hmrs']);
    await receiver.waitFor('newDevices', 15000);
    return {rfd, receiver};
}

async function faultOrResult(promise) {
    return promise.then(
        (result) => (result && typeof result === 'object' && 'faultCode' in result ? {fault: result} : {result}),
        (error) => ({fault: error}),
    );
}

test(
    'telegrams from a paired device with mutated content reach the device model and do not crash rfd (seeded)',
    options(),
    async (t) => {
        const seed = seedFromEnvironment();
        t.diagnostic(`HMRS_SEED=${seed}`);
        const rng = mulberry32(seed);
        const {rfd, receiver} = await rfdWithReceiver();
        await withDaemon(rfd, async () => {
            const {air, device: sw} = attachSwitch(rfd);
            await pairDevice(rfd, receiver, air, sw);
            const valid = [
                sw.statusTelegram(1),
                sw.statusTelegram(1, {bidi: false}),
                sw.sysinfoTelegram(rfd.module.rfAddress),
            ];
            const from = receiver.received.length;
            const iterations = Number(process.env.HMRS_FUZZ_FRAMES || 400);
            for (let i = 0; i < iterations; i++) {
                const kind = rng.int(4);
                let bytes;
                if (kind === 0) {
                    // a valid telegram of the device with one to three bytes after the addresses changed
                    bytes = Buffer.from(valid[rng.int(valid.length)]);
                    for (let n = 0; n <= rng.int(3); n++) {
                        if (bytes.length > 9) {
                            bytes[9 + rng.int(bytes.length - 9)] = rng.byte();
                        }
                    }
                } else if (kind === 1) {
                    // a valid telegram cut short or grown
                    bytes = Buffer.from(valid[rng.int(valid.length)]);
                    bytes = rng.int(2)
                        ? bytes.subarray(0, 9 + rng.int(bytes.length - 8))
                        : Buffer.concat([bytes, rng.bytes(1 + rng.int(8))]);
                } else {
                    // any type and payload, from the paired device's address to the central
                    bytes = encodeTelegram({
                        counter: rng.byte(),
                        ctrl: (rng.int(2) ? CTRL.BIDI : 0) | CTRL.RPT_ENABLE | (rng.int(8) === 0 ? CTRL.BCAST : 0),
                        type:
                            kind === 2
                                ? [0x00, 0x02, 0x10, 0x3f, 0x40, 0x41, 0x53, 0x5e, 0x70][rng.int(9)]
                                : rng.byte(),
                        src: SWITCH_ADDRESS,
                        dst: rfd.module.rfAddress,
                        payload: rng.bytes(rng.int(17)),
                    });
                }
                rfd.module.sendEvent(bytes, {rssi: -40 - rng.int(50)});
                if (i % 10 === 0) {
                    await sleep(20);
                }
            }
            await sleep(3000);
            const events = receiver.received.slice(from).filter((r) => r.method === 'event').length;
            t.diagnostic(`${iterations} telegrams from the paired switch, ${events} events at the receiver`);
            assert.ok(rfd.alive, `rfd died (seed ${seed}): ${JSON.stringify(rfd.exit)}`);
            // the device still works afterwards - within 30 s only without the devices-lock-wait finding: every
            // sysinfo among the frames makes rfd re-add the device to the module under its device lock, and a frame
            // for the central in that moment costs a coprocessor timeout (1000 ms) per command; how many depends on
            // how the frames fall around rfd's commands (0 to 33 s measured), so this part is known where the
            // finding is
            await t.test(
                'the device answers setValue within 30 s afterwards (finding devices-lock-wait)',
                regression('devices-lock-wait'),
                async () => {
                    await rfd.call('setValue', [`${SWITCH_SERIAL}:1`, 'STATE', true], {timeout: 30000});
                    assert.equal(sw.behaviour.channel(1).STATE, 200);
                },
            );
            const reports = rfd.sanitizerReports();
            assert.equal(
                reports.length,
                0,
                `sanitizer reports (seed ${seed}):\n${reports.map((r) => r.text).join('\n')}`,
            );
        }).finally(() => receiver.stop());
    },
);

test(
    'a frame for the central while rfd re-adds a paired device after its sysinfo does not cost module timeouts (finding devices-lock-wait)',
    options(regression('devices-lock-wait')),
    async (t) => {
        // rfd answers a sysinfo from a paired device outside install mode by adding the device to the module again
        // (ADD_LINK_PEER, then its AES policy) and holds its device lock while it waits for the answers; the receive
        // thread takes the same lock for every frame addressed to the central. Timing assumptions (rfd 3.89.11):
        // coproCommandTimeout = 1000 ms; the module answers ADD_LINK_PEER after 300 ms here (chosen: a slow answer,
        // as through multimacd or a LAN gateway, well inside the window), the status telegram comes 100 ms after the
        // command, so it is read while rfd waits.
        const {rfd, receiver} = await rfdWithReceiver();
        await withDaemon(rfd, async () => {
            const {air, device: sw} = attachSwitch(rfd);
            await pairDevice(rfd, receiver, air, sw);
            const module = rfd.module;
            const adds = module.commands.filter((c) => c.name === 'ADD_LINK_PEER').length;
            const timeouts = () =>
                rfd.grep(/waitForCoProcessorResponse\(\): Timeout while waiting for response/).length;
            const before = timeouts();
            module.inject('ADD_LINK_PEER', {delayMs: 300});
            module.sendEvent(sw.sysinfoTelegram(module.rfAddress));
            await module.waitForCommand('ADD_LINK_PEER', {count: adds + 1, timeout: 5000});
            await sleep(100);
            module.sendEvent(sw.statusTelegram(1));
            await sleep(3000);
            const lost = timeouts() - before;
            t.diagnostic(`coprocessor timeouts after the sysinfo: ${lost}`);
            assert.ok(rfd.alive, `rfd died: ${JSON.stringify(rfd.exit)}`);
            assert.equal(
                lost,
                0,
                `rfd timed out waiting for the module ${lost} time(s) although the answer came after 300 ms\n${rfd.tail()}`,
            );
        }).finally(() => receiver.stop());
    },
);

test(
    '#260 (#175): a malformed JSON value for USER_COLOR (HM-LC-RGBW-WM, a parameter with write dependencies) is refused, rfd lives',
    options(regression(260)),
    async (t) => {
        const {rfd, receiver} = await rfdWithReceiver();
        await withDaemon(rfd, async () => {
            const {air} = attachSwitch(rfd, {address: 0x13579b, serial: 'SIM0000777'});
            const rgbw = air.add(
                new BidcosDevice({
                    address: RGBW_ADDRESS,
                    serial: RGBW_SERIAL,
                    description: description('rf_rgbw.xml'),
                    typeId: 'HM-LC-RGBW-WM',
                }),
            );
            await pairDevice(rfd, receiver, air, rgbw);
            // a well-formed value is taken (whatever the device answers)
            const good = await faultOrResult(
                rfd.call('setValue', [`${RGBW_SERIAL}:2`, 'USER_COLOR', '{"ACT_HSV_COLOR_VALUE":"100"}'], {
                    timeout: 30000,
                }),
            );
            t.diagnostic(`well-formed USER_COLOR: ${JSON.stringify(good).slice(0, 120)}`);
            assert.ok(rfd.alive, 'rfd lives after a well-formed value');
            // a key without a value: JSONObject::parseBlock computes s.length() - 1 on an empty string and calls
            // substr(1) - std::out_of_range, caught by nobody between it and the RPC server
            const bad = await faultOrResult(
                rfd.call('setValue', [`${RGBW_SERIAL}:2`, 'USER_COLOR', '{"ACT_HSV_COLOR_VALUE":}'], {timeout: 10000}),
            );
            await sleep(1000);
            t.diagnostic(
                `malformed USER_COLOR: ${JSON.stringify(bad).slice(0, 160)}; rfd ${rfd.alive ? 'alive' : `ended ${JSON.stringify(rfd.exit)}`}; ${rfd
                    .grep(/out_of_range|terminate/)
                    .slice(-2)
                    .join(' | ')}`,
            );
            assert.ok(rfd.alive, 'rfd survives a malformed JSON value');
            assert.ok(bad.fault, 'the malformed value is a fault');
        }).finally(() => receiver.stop());
    },
);

test(
    '#263 (#177): a configuration line longer than 255 characters: rfd starts',
    options(regression(263)),
    async (t) => {
        // PropertyMap::ReadFromFile reads with istream::getline(line, 256): a longer line sets failbit, eof() never
        // becomes true, and the loop reads nothing for ever - the daemon never gets past its configuration
        const rfd = await spawnRfd({extra: `# ${'a long comment, '.repeat(20)}`});
        const ready = await rfd.waitReady(20000).then(
            () => true,
            () => false,
        );
        t.diagnostic(
            `rfd with a ${'a long comment, '.repeat(20).length + 2}-character line in rfd.conf: ${ready ? 'ready' : `not ready after 20 s, ${rfd.alive ? 'still running' : `ended ${JSON.stringify(rfd.exit)}`}`}`,
        );
        await rfd.stop();
        assert.ok(ready, 'rfd answers RPC with a long line in its configuration');
    },
);

function wiredSwitch() {
    return new WiredDevice({
        address: 0x00004711,
        serial: 'SIMW000001',
        description: loadDeviceDescription(path.join(HS485TYPES, 'hmw_lc_sw2_dr.xml')),
        typeId: 'HMW-LC-Sw2-DR',
        sysinfo: [0x11, 0x00, 0x03, 0x05],
    });
}

test(
    '#267 (#176): a wired firmware file without a data record: hs485d reports no firmware and lives',
    options(regression(267)),
    async (t) => {
        const dir = tmpdir('hmrs-hs485d');
        fs.mkdirSync(path.join(dir, 'firmware'), {recursive: true});
        // the map (type, file, the version's address in it - the format of the shipped fwmap); the file is only an
        // end-of-file record, so Hexfile::Read never sets a start address and erases from begin() to begin() - 1
        fs.writeFileSync(path.join(dir, 'firmware', 'fwmap'), 'H17V0\thmrs_empty.hex\t@0x77F0\n');
        fs.writeFileSync(path.join(dir, 'firmware', 'hmrs_empty.hex'), ':00000001FF\n');
        const bus = new WiredBus();
        bus.add(wiredSwitch());
        const hs485d = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus, dir});
        await withDaemon(hs485d, async () => {
            // the search finds the device and asks the firmware manager for its available firmware (GetFirmwareVersion)
            const search = await faultOrResult(hs485d.call('searchDevices', [], {timeout: 30000}));
            await sleep(1000);
            t.diagnostic(
                `searchDevices: ${JSON.stringify(search).slice(0, 120)}; hs485d ${hs485d.alive ? 'alive' : `ended ${JSON.stringify(hs485d.exit)}`}; last log: ${hs485d.log.slice(-1).join('')}`,
            );
            assert.ok(hs485d.alive, 'hs485d survives the firmware file');
            assert.equal(search.result, 1, 'the device was found');
            const desc = await hs485d.call('getDeviceDescription', ['SIMW000001'], {timeout: 10000});
            assert.equal(desc.AVAILABLE_FIRMWARE || '', '', 'no firmware available from a file without data');
            assert.deepEqual(hs485d.sanitizerReports(), []);
        });
    },
);

test(
    '#267 (#176): a version address right before the firmware data: hs485d reports no firmware and lives',
    options(regression(267)),
    async (t) => {
        const dir = tmpdir('hmrs-hs485d');
        fs.mkdirSync(path.join(dir, 'firmware'), {recursive: true});
        // HS485FirmwareManager::GetFirmwareVersion: position = version address - start, unsigned. One byte before the
        // data it wraps to 0xFFFFFFFF, position + 1 wraps to 0 and passes the size check, and the read goes far out of
        // the buffer. The data starts at 0x1000 (a type 00 record with 16 bytes), the map names 0x0FFF.
        const record = [0x10, 0x10, 0x00, 0x00, ...new Array(16).fill(0x55)];
        const crc = (0x100 - (record.reduce((sum, b) => sum + b, 0) & 0xff)) & 0xff;
        const data = [...record, crc]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase();
        fs.writeFileSync(path.join(dir, 'firmware', 'fwmap'), 'H17V0\thmrs_before.hex\t@0x0FFF\n');
        fs.writeFileSync(path.join(dir, 'firmware', 'hmrs_before.hex'), `:${data}\n:00000001FF\n`);
        const bus = new WiredBus();
        bus.add(wiredSwitch());
        const hs485d = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus, dir});
        await withDaemon(hs485d, async () => {
            const search = await faultOrResult(hs485d.call('searchDevices', [], {timeout: 30000}));
            await sleep(1000);
            t.diagnostic(
                `searchDevices: ${JSON.stringify(search).slice(0, 120)}; last log: ${hs485d.log.slice(-1).join('')}`,
            );
            assert.ok(hs485d.alive, 'hs485d survives the firmware map');
            assert.equal(search.result, 1, 'the device was found');
            const desc = await hs485d.call('getDeviceDescription', ['SIMW000001'], {timeout: 10000});
            assert.equal(desc.AVAILABLE_FIRMWARE || '', '', 'no firmware from an address before the data');
            assert.deepEqual(hs485d.sanitizerReports(), []);
        });
    },
);

test(
    'hs485d device directory: a directory named X.dev and an empty .dev are skipped, the good device stays',
    options(),
    async (t) => {
        const bus = new WiredBus();
        bus.add(wiredSwitch());
        const first = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus});
        const dir = first.dir;
        await withDaemon(first, async () => {
            assert.equal(await first.call('searchDevices', [], {timeout: 60000}), 1);
            await sleep(2000);
        });
        const devices = path.join(dir, 'devices');
        const files = fs.readdirSync(devices);
        t.diagnostic(`device files: ${files.join(' ')}`);
        fs.mkdirSync(path.join(devices, 'DIRDEV0001.dev'));
        fs.writeFileSync(path.join(devices, 'EMPTY00001.dev'), '');
        const second = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus, dir});
        await withDaemon(second, async () => {
            const list = (await second.call('listDevices')).map((d) => d.ADDRESS);
            t.diagnostic(`after the restart: ${list.join(' ')}`);
            assert.ok(list.includes('SIMW000001'), 'the good device is back');
            assert.ok(!list.includes('DIRDEV0001') && !list.includes('EMPTY00001'));
            assert.ok(second.alive);
            assert.deepEqual(second.sanitizerReports(), []);
        });
    },
);
