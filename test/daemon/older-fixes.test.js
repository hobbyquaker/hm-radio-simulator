/**
 * Regression tests for OpenCCU-Base fixes older than every ref the suite builds, and older than its CMake build
 * (45377689, 2026-06-23), so they can never run as todo and scripts/prove.mjs cannot build their parents: they pin
 * the behaviour so it does not come back. Each test names its commit (test/metadata.js, UPSTREAM_COMMITS).
 *
 * - c57eb49f (hs485d, 2026-01-10): `PRIX32` instead of a decimal format - a wired device without a serial gets
 *   `ELV%08X` of its address as serial (`ELV00004711`, not `ELV00018193`), and a link peer whose address no device
 *   has is `@%08X` (`HS485Manager::BuildStringAddress`; the `.dev` file's `address="0x..."`, the third site, is
 *   pinned by hs485d-sweep's restart test);
 * - bf7851d1 (hs485d, 2025-06-13): the `rfind('.')` of a device-directory file name kept in a `std::string::size_type`
 *   instead of an `unsigned int` - a file without a dot in the directory;
 * - fc83bfd4 (libXmlRpc, 2018-10-10): workarounds for lazy servers in `XmlRpcClient` - a response with
 *   `Content-Length: 0`, a header whose `\r\n\r\n` are the last bytes of a read, a `<methodResponse>` without
 *   `<params>`; and every request carries `<params>`, also without parameters;
 * - 90c666c0 (libXmlRpc, 2025-05-23): the dispatcher's millisecond clock `getTime()` in 64 bits - in 32 bits it wrapped
 *   every 49.7 days, and a timeout computed across the wrap ended at once or never. The test moves the daemon's clock
 *   with libfaketime (LD_PRELOAD, the offset in a file it re-reads every second) so that the wrap falls into a pending
 *   callback; the same set-up steps the wall clock by +1 h and -1 h, as an NTP step at boot does on a system without
 *   RTC (the fix still reads CLOCK_REALTIME). Measured on 3.89.11 and main: the callback timeout is 10 s in all three
 *   cases - the client's timeout does not follow the wall clock, so the CLOCK_REALTIME candidate is no finding.
 *
 * Timing assumptions: the event dispatcher's XmlRpcClient timeout is 10 000 ms and a failed batch is tried twice
 * (libhsscomm HSSXmlRpcEventDispatcher); "at once" is 3 s, as in receiver-misbehaviour.test.js. hs485d saves its
 * device files from a 5000 ms timer (RequestSave).
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {startRfd, startHs485d, withDaemon, skipWithoutDaemons, HS485TYPES, tmpdir} from '../helpers/daemon.js';
import {startReceiver, BinRpcClient} from '../helpers/rpc.js';
import {startRawReceiver} from '../helpers/raw-receiver.js';
import {loadDeviceDescription} from '../../lib/rftypes.js';
import {WiredBus, WiredDevice} from '../../lib/wired.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 300000, ...extra});
const AT_ONCE_MS = 3000;
/** HSSXmlRpcEventDispatcher's client timeout (libhsscomm). */
const DISPATCH_TIMEOUT_MS = 10000;

function wiredSwitch(extra = {}) {
    return new WiredDevice({
        address: 0x00004711,
        serial: 'SIMW000001',
        description: loadDeviceDescription(path.join(HS485TYPES, 'hmw_lc_sw2_dr.xml')),
        typeId: 'HMW-LC-Sw2-DR',
        sysinfo: [0x11, 0x00, 0x03, 0x05],
        ...extra,
    });
}

async function waitUntil(predicate, timeoutMs, what) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (await predicate()) {
            return;
        }
        await sleep(100);
    }
    throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`);
}

// ---------------------------------------------------------------------------------------------------------------
// hs485d

test(
    'hs485d: a wired device without a serial is named ELV and its address in hex, before and after a restart (c57eb49f)',
    options(),
    async (t) => {
        // a description that says has_serial="false" (HS485DeviceDescription), next to the image's descriptions:
        // hs485d then makes the serial itself (HS485Device::DetermineSerial) instead of asking the device with `n`
        const descriptions = fs.mkdtempSync(path.join('/tmp', 'hmrs-hs485types-'));
        for (const f of fs.readdirSync(HS485TYPES)) {
            fs.symlinkSync(path.join(HS485TYPES, f), path.join(descriptions, f));
        }
        const fixture = fs.readFileSync(path.join(FIXTURES, 'hs485types', 'sim_wired_switch.xml'), 'latin1');
        fs.writeFileSync(
            path.join(descriptions, 'sim_noserial.xml'),
            fixture
                .replace('<device version="12"', '<device version="12" has_serial="false"')
                .replace('id="SIM-HMW-Sw2"', 'id="SIM-HMW-NS"')
                .replace('const_value="17"', 'const_value="0x93"'),
            'latin1',
        );
        const bus = new WiredBus();
        bus.add(
            new WiredDevice({
                address: 0x00004711,
                serial: null,
                description: loadDeviceDescription(path.join(descriptions, 'sim_noserial.xml')),
                typeId: 'SIM-HMW-NS',
                sysinfo: [0x93, 0x00, 0x03, 0x05],
            }),
        );
        const first = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus, descriptionDir: descriptions});
        const dir = first.dir;
        await withDaemon(first, async () => {
            assert.equal(await first.call('searchDevices', [], {timeout: 60000}), 1);
            const list = (await first.call('listDevices')).map((d) => d.ADDRESS);
            t.diagnostic(`after the discovery: ${list.filter((a) => !a.includes(':')).join(' ')}`);
            assert.ok(list.includes('ELV00004711'), `ELV and the address 0x4711 in hex: ${list.join(' ')}`);
            assert.ok(!list.includes('ELV00018193'), 'not the address in decimal');
            await sleep(6000); // the save timer
        });
        const files = fs.readdirSync(path.join(dir, 'devices'));
        t.diagnostic(`device files: ${files.join(' ')}`);
        const second = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus, dir, descriptionDir: descriptions});
        await withDaemon(second, async () => {
            const list = (await second.call('listDevices')).map((d) => d.ADDRESS);
            t.diagnostic(`after the restart: ${list.filter((a) => !a.includes(':')).join(' ')}`);
            assert.ok(list.includes('ELV00004711'), 'the same name from the device file');
            assert.deepEqual(second.sanitizerReports(), []);
        });
    },
);

test(
    'hs485d: a link peer whose address no device on the bus has is shown as @ and the address in hex (c57eb49f)',
    options(),
    async (t) => {
        // the key channel's link EEPROM (hmw_input_ch_link: address_start 0x357, step 6 - the own physical channel,
        // the peer's address (4 bytes) and its channel) holds one entry to an address no device on the bus has;
        // hs485d names such a peer `@%08X` (HS485Manager::BuildStringAddress, the second site of the fix, reached
        // through HS485TypeConversionAddressArray) - before c57eb49f in decimal (`@39321`)
        const sw = wiredSwitch();
        sw.eeprom.set([0x00, 0x00, 0x00, 0x99, 0x99, 0x01], 0x357);
        const bus = new WiredBus();
        bus.add(sw);
        const hs485d = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus});
        await withDaemon(hs485d, async () => {
            assert.equal(await hs485d.call('searchDevices', [], {timeout: 60000}), 1);
            const peers = await hs485d.call('getLinkPeers', ['SIMW000001:1']);
            t.diagnostic(`link peers of the key channel: ${JSON.stringify(peers)}`);
            assert.ok(peers.includes('@00009999:1'), `the unknown peer as @ and hex: ${JSON.stringify(peers)}`);
            assert.ok(!peers.some((p) => /39321/.test(p)), 'not the address in decimal');
            const links = await hs485d.call('getLinks', ['SIMW000001:1', 0]);
            t.diagnostic(`getLinks of the key channel: ${JSON.stringify(links).slice(0, 300)}`);
            assert.ok(hs485d.alive);
            assert.deepEqual(hs485d.sanitizerReports(), []);
        });
    },
);

test(
    'hs485d device directory: files without a dot are skipped, the good device stays (bf7851d1)',
    options(),
    async (t) => {
        const bus = new WiredBus();
        bus.add(wiredSwitch());
        const first = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus});
        const dir = first.dir;
        await withDaemon(first, async () => {
            assert.equal(await first.call('searchDevices', [], {timeout: 60000}), 1);
            await sleep(6000); // the save timer
        });
        const devices = path.join(dir, 'devices');
        // before bf7851d1 rfind('.') == npos was truncated to 0xffffffff in an unsigned int and the name was cut there
        fs.writeFileSync(path.join(devices, 'NODOT00001'), '<?xml version="1.0"?><device/>');
        fs.writeFileSync(path.join(devices, 'README'), 'not a device file\n');
        t.diagnostic(`device files: ${fs.readdirSync(devices).join(' ')}`);
        const second = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus, dir});
        await withDaemon(second, async () => {
            const list = (await second.call('listDevices')).map((d) => d.ADDRESS);
            t.diagnostic(`after the restart: ${list.filter((a) => !a.includes(':')).join(' ')}`);
            assert.ok(list.includes('SIMW000001'), 'the good device is back');
            assert.ok(!list.includes('NODOT00001'));
            assert.ok(second.alive);
            assert.deepEqual(second.sanitizerReports(), []);
        });
    },
);

// ---------------------------------------------------------------------------------------------------------------
// libXmlRpc: lazy servers (the daemons as clients of a receiver)

const LAZY_MODES = ['empty-length', 'split-header', 'no-params'];

const FLAVOURS = [
    {name: 'rfd', start: () => startRfd(), initArgs: (url, id) => [url, id]},
    {
        name: 'hs485d',
        start: () => startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus: new WiredBus()}),
        initArgs: (url, id) => [url, id, false],
    },
];

function pongs(receiver) {
    return receiver.received.filter((r) => r.method === 'event' && r.params[2] === 'PONG').map((r) => r.params[3]);
}

for (const flavour of FLAVOURS) {
    test(
        `${flavour.name}: a receiver that answers like a lazy server (${LAZY_MODES.join(', ')}) is done with every event at once, no hang, no retry storm; every request carries <params> (fc83bfd4)`,
        options({timeout: 600000}),
        async (t) => {
            const good = await startReceiver();
            const lazy = await startRawReceiver({protocol: 'xmlrpc'});
            const daemon = await flavour.start();
            const probe = new BinRpcClient(daemon.port);
            try {
                await withDaemon(daemon, async () => {
                    await daemon.call('init', flavour.initArgs(good.url, 'good'));
                    await daemon.call('init', flavour.initArgs(lazy.url, 'lazy'), {timeout: 30000});
                    let n = 0;
                    const ping = async (value) => {
                        const at = Date.now();
                        await probe.call('ping', [value], {timeout: AT_ONCE_MS});
                        await waitUntil(() => pongs(good).includes(value), AT_ONCE_MS, `PONG ${value} at the good one`);
                        return Date.now() - at;
                    };
                    await ping(`warm-${n++}`);
                    await waitUntil(
                        () => lazy.requests.some((r) => r.method === 'system.multicall' || r.method === 'event'),
                        5000,
                        'events at the lazy receiver',
                    );
                    for (const mode of LAZY_MODES) {
                        lazy.misbehave(mode);
                        const from = lazy.requests.length;
                        const pings = 3;
                        const pingTimes = [];
                        for (let i = 0; i < pings; i++) {
                            pingTimes.push(Date.now());
                            await ping(`${mode}-${n++}`);
                            // one batch per ping: the next ping only after the lazy receiver had this one
                            await waitUntil(
                                () => lazy.requests.slice(from).filter((r) => r.mode === mode).length >= i + 1,
                                AT_ONCE_MS,
                                `the ping at the lazy receiver (${mode})`,
                            );
                            await sleep(1000);
                        }
                        // a hung call ends only after the dispatcher's timeout and comes again then: wait past it
                        await sleep(DISPATCH_TIMEOUT_MS + 2000);
                        const hits = lazy.requests.slice(from).filter((r) => r.mode === mode);
                        const late = hits.filter((r) => r.at - pingTimes.findLast((p) => p <= r.at) > AT_ONCE_MS);
                        t.diagnostic(
                            `${mode}: ${hits.length} deliveries for ${pings} pings, at +${hits.map((r) => r.at - pingTimes.findLast((p) => p <= r.at)).join(', +')} ms after their ping`,
                        );
                        // measured on 3.89.11: an empty answer counts as a failed call and is tried a second time at
                        // once (2 per ping); before fc83bfd4 its header was never complete and the call hung for the
                        // timeout, twice
                        assert.ok(
                            hits.length >= pings && hits.length <= 2 * pings,
                            `${mode}: ${hits.length} deliveries`,
                        );
                        assert.deepEqual(
                            late.map((r) => r.at),
                            [],
                            `${mode}: deliveries later than ${AT_ONCE_MS} ms after their ping - a call that hung`,
                        );
                        // and the dispatcher is free: back to proper answers, the next event arrives at once
                        lazy.misbehave('ok');
                        const okFrom = lazy.requests.length;
                        await ping(`${mode}-ok-${n++}`);
                        await waitUntil(
                            () => lazy.requests.slice(okFrom).some((r) => r.mode === 'ok'),
                            AT_ONCE_MS,
                            `the lazy receiver back in step after ${mode}`,
                        );
                        assert.ok(daemon.alive, `${flavour.name} died on ${mode}`);
                    }
                    await probe.call('listDevices', [], {timeout: AT_ONCE_MS});
                    // generateRequest writes <params></params> even for a call without parameters
                    const bodies = lazy.requests.filter((r) => r.body !== undefined);
                    t.diagnostic(`requests: ${[...new Set(bodies.map((r) => r.method))].join(' ')}`);
                    assert.ok(bodies.length > 0);
                    for (const r of bodies) {
                        assert.match(r.body, /<params>/, `${r.method} without <params>: ${r.body.slice(0, 200)}`);
                    }
                    assert.deepEqual(daemon.sanitizerReports(), []);
                });
            } finally {
                probe.client.close(); // else it reconnects to a stopped daemon forever and the file never ends
                await lazy.stop();
                await good.stop();
            }
        },
    );
}

// ---------------------------------------------------------------------------------------------------------------
// libXmlRpc: the dispatcher's clock

const FAKETIME_LIB = '/usr/lib/x86_64-linux-gnu/faketime/libfaketimeMT.so.1';
const skipWithoutFaketime = fs.existsSync(FAKETIME_LIB) ? {} : {skip: `no libfaketime (${FAKETIME_LIB})`};
const WRAP_MS = 2 ** 32;

/** The environment that gives a daemon a clock we can move: the offset in `file`, re-read every second. */
function faketime(file) {
    fs.writeFileSync(file, '+0\n');
    return {
        LD_PRELOAD: FAKETIME_LIB,
        FAKETIME_TIMESTAMP_FILE: file,
        FAKETIME_CACHE_DURATION: '1',
        // an NTP step moves the wall clock only; CLOCK_MONOTONIC keeps running
        FAKETIME_DONT_FAKE_MONOTONIC: '1',
    };
}

/** The offset (seconds) that puts the daemon's wall clock `ms` before the next 2^32 ms boundary of the epoch. */
function offsetBeforeWrap(ms) {
    const now = Date.now();
    let wrap = Math.ceil(now / WRAP_MS) * WRAP_MS;
    if (wrap - now < ms + 10000) {
        wrap += WRAP_MS;
    }
    return (wrap - ms - now) / 1000;
}

const CLOCK_CASES = [
    {
        name: 'the 32-bit millisecond clock wraps while the call is pending',
        // set before the call: the wrap 6 s later, inside the 10 s the call is pending
        before: () => offsetBeforeWrap(6000),
    },
    {
        name: 'the wall clock steps forward by one hour while the call is pending',
        during: 3600,
    },
    {
        name: 'the wall clock steps back by one hour while the call is pending',
        during: -3600,
    },
];

for (const flavour of FLAVOURS) {
    test(
        `${flavour.name}: a receiver that does not answer is given up after the callback timeout, whatever the wall clock does (90c666c0)`,
        options({...skipWithoutFaketime, timeout: 600000}),
        async (t) => {
            const clockFile = path.join(tmpdir('hmrs-faketime'), 'offset');
            const env = faketime(clockFile);
            const good = await startReceiver();
            const bad = await startRawReceiver();
            const daemon =
                flavour.name === 'rfd'
                    ? await startRfd({env})
                    : await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus: new WiredBus(), env});
            const probe = new BinRpcClient(daemon.port);
            const setOffset = async (seconds) => {
                fs.writeFileSync(clockFile, `${seconds >= 0 ? '+' : ''}${seconds.toFixed(3)}\n`);
                await sleep(1500); // libfaketime re-reads the file every second
            };
            try {
                await withDaemon(daemon, async () => {
                    await daemon.call('init', flavour.initArgs(good.url, 'good'));
                    await daemon.call('init', flavour.initArgs(bad.url, 'bad'), {timeout: 30000});
                    let n = 0;
                    const ping = async (value) => {
                        await probe.call('ping', [value], {timeout: AT_ONCE_MS});
                        await waitUntil(() => pongs(good).includes(value), AT_ONCE_MS, `PONG ${value} at the good one`);
                    };
                    await ping(`warm-${n++}`);
                    await waitUntil(() => bad.requests.some((r) => r.mode === 'ok'), 5000, 'events at the bad one');
                    let offset = 0;
                    for (const c of CLOCK_CASES) {
                        await t.test(c.name, async () => {
                            if (c.before) {
                                offset = c.before();
                                await setOffset(offset);
                            }
                            bad.misbehave('no-answer');
                            const from = bad.requests.length;
                            await ping(`${c.name}-${n++}`);
                            await waitUntil(
                                () => bad.requests.slice(from).some((r) => r.mode === 'no-answer'),
                                AT_ONCE_MS,
                                'the call at the receiver that does not answer',
                            );
                            const first = bad.requests.slice(from).find((r) => r.mode === 'no-answer').at;
                            if (c.during) {
                                await sleep(1000);
                                offset += c.during;
                                await setOffset(offset);
                            }
                            // the batch is tried twice: the second try comes when the first one timed out
                            const deadline = first + 3 * DISPATCH_TIMEOUT_MS;
                            while (bad.requests.slice(from).filter((r) => r.mode === 'no-answer').length < 2) {
                                if (Date.now() > deadline) {
                                    break;
                                }
                                // meanwhile the daemon answers RPC and the good receiver gets its events
                                await ping(`${c.name}-meanwhile-${n++}`);
                                await sleep(500);
                            }
                            // the daemon really runs on the moved clock: its log's time stamps (local time) are off by
                            // the offset
                            const stamped = daemon.grep(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d/);
                            const last = stamped[stamped.length - 1] || '';
                            const m = /^(\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)/.exec(last);
                            const skew = m
                                ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() - Date.now()
                                : null;
                            t.diagnostic(
                                `the daemon's clock: ${skew === null ? 'no time stamp' : `${Math.round(skew / 1000)} s`} off, the offset ${Math.round(offset)} s`,
                            );
                            assert.ok(
                                skew !== null && Math.abs(skew - offset * 1000) < 30000,
                                `the daemon does not run on the moved clock: ${last}`,
                            );
                            const tries = bad.requests.slice(from).filter((r) => r.mode === 'no-answer');
                            const gap = tries.length >= 2 ? tries[1].at - tries[0].at : null;
                            t.diagnostic(
                                `${c.name}: the second try ${gap === null ? 'never came' : `${gap} ms after the first`}`,
                            );
                            bad.misbehave('ok');
                            // let the dispatcher finish with the bad receiver before the next case
                            await sleep(2 * DISPATCH_TIMEOUT_MS + 2000);
                            assert.ok(daemon.alive, `${flavour.name} died`);
                            assert.ok(gap !== null, `the call never timed out (${3 * DISPATCH_TIMEOUT_MS} ms)`);
                            assert.ok(
                                gap > DISPATCH_TIMEOUT_MS - 2000 && gap < DISPATCH_TIMEOUT_MS + 5000,
                                `the call timed out after ${gap} ms, not after ~${DISPATCH_TIMEOUT_MS} ms`,
                            );
                        });
                    }
                    assert.deepEqual(daemon.sanitizerReports(), []);
                });
            } finally {
                probe.client.close();
                await bad.stop();
                await good.stop();
            }
        },
    );
}
