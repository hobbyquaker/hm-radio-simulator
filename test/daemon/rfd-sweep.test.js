/**
 * The sweeps over rfd: the RPC method sweep (every method of the dispatcher table with valid, missing and
 * wrong-typed arguments) and the device-type sweep (one instance of every type in rftypes, without radio, through
 * `addVirtualDeviceInstance`, then the descriptions, paramsets and values of every device and channel). Both record
 * a summary of every answer; the report diffs the records of the refs (the differential).
 *
 * Timing assumptions: none beyond rfd answering a local call within 15 s (a call that does not is recorded as
 * `timeout` and fails the test when rfd is dead afterwards). The empty air behind the module reports a send to an
 * absent device as failed at once, so calls that make rfd talk to a device do not wait for the radio timeouts.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {startRfd, withDaemon, skipWithoutDaemons, RFTYPES} from '../helpers/daemon.js';
import {SweepCaller, readMethodTable, writeRecord, summarize} from '../helpers/sweep.js';
import {regression, isKnownBroken} from '../helpers/known.js';
import {Air} from '../../lib/air.js';
import {loadDeviceDescription, sysinfoSatisfying} from '../../lib/rftypes.js';
import {encodeTelegram, FT} from '../../lib/telegram.js';

const CENTRAL = 'BidCoS-RF';
const UNKNOWN = 'NOSUCH0001';
const SWITCH_FILE = 'rf_s.xml';
const SWITCH_TYPE = 'HM-LC-Sw1-Pl';

/**
 * The announcement (sysinfo telegram) of a device of `typeId`, as `addVirtualDeviceInstance` takes it: the bytes of
 * the telegram from the counter on, with every condition of the type's `<supported_types>` entry satisfied.
 * Two channels for a `count_from_sysinfo` channel type; a peering channel when the description expects one.
 */
export function announcement(description, typeId, address, serial) {
    const base = encodeTelegram({
        counter: 1,
        ctrl: 0x84,
        type: FT.SYSINFO,
        src: address,
        dst: 0,
        payload: [
            0x10,
            0x00,
            0x00,
            ...Buffer.from(serial, 'ascii'),
            0x00,
            0x02,
            description.peeringSysinfoExpectChannel ? 0x01 : 0x00,
            0x00,
        ],
    });
    return sysinfoSatisfying(description, typeId, base);
}

/**
 * rfd with the simulated module and an empty air in which a telegram to an absent device fails fast (50 ms instead
 * of the module's 3 s of retries): the sweeps make rfd ask its virtual devices for their config, and nobody answers.
 */
async function startSweepRfd() {
    const rfd = await startRfd({module: {failDelayMs: 50}});
    rfd.air = new Air({module: rfd.module, absentFails: true});
    return rfd;
}

/**
 * The metadata methods index their second argument after taking a pointer into the first; with fewer arguments the
 * array is reallocated under that pointer (the metadata-args finding: a heap-use-after-free under ASan).
 */
const METADATA_ARGS = {getMetadata: 2, setMetadata: 3, setVolatileMetadata: 2};

/** Calls the sweep leaves out while a finding is unfixed in the ref (they get their own regression test). */
function skipKnown(method, params) {
    if (isKnownBroken('metadata-args') && method in METADATA_ARGS && params.length < METADATA_ARGS[method]) {
        return 'metadata-args';
    }
    return null;
}

/** The descriptions that use type_conversion_string_unsigned_integer (the string-uint-conversion finding). */
function usesStringUint(file) {
    return fs.readFileSync(path.join(RFTYPES, file), 'latin1').includes('"string_unsigned_integer"');
}

/** Every type of every rftypes file, in a fixed order. */
function allTypes() {
    const out = [];
    for (const file of fs
        .readdirSync(RFTYPES)
        .filter((f) => f.endsWith('.xml'))
        .sort()) {
        let description;
        try {
            description = loadDeviceDescription(path.join(RFTYPES, file));
        } catch {
            continue;
        }
        for (const type of description.types) {
            out.push({file, description, typeId: type.id});
        }
    }
    return out;
}

/** The valid calls of the method sweep, in the order they run (the destructive ones last). */
function rfdCalls({device, channel, moduleSerial, receiverUrl}) {
    return [
        ['listDevices', []],
        ['listTeams', []],
        ['getVersion', []],
        ['getInstallMode', []],
        ['listBidcosInterfaces', []],
        ['rssiInfo', []],
        ['getServiceMessages', []],
        ['refreshDeployedDeviceFirmwareList', []],
        ['getDeviceDescription', [device]],
        ['getParamsetDescription', [channel, 'MASTER']],
        ['getParamsetDescription', [channel, 'VALUES']],
        ['getParamsetDescription', [`${CENTRAL}:1`, 'LINK']],
        ['getParamsetId', [channel, 'MASTER']],
        ['getParamset', [channel, 'MASTER']],
        ['getParamset', [channel, 'VALUES']],
        ['getParamset', [device, 'MASTER', 0]],
        ['getValue', [channel, 'STATE']],
        ['getValue', [`${UNKNOWN}:1`, 'STATE']],
        ['setValue', [channel, 'STATE', true]],
        ['setValue', [`${CENTRAL}:1`, 'PRESS_SHORT', true]],
        ['putParamset', [channel, 'MASTER', {}]],
        ['putParamset', [channel, 'VALUES', {STATE: false}]],
        ['determineParameter', [channel, 'MASTER', 'POWERUP_ACTION']],
        ['reportValueUsage', [channel, 'STATE', 1]],
        ['getLinkPeers', [channel]],
        ['getLinks', [channel, 0]],
        ['addLink', [`${CENTRAL}:1`, channel, 'sweep', 'a sweep link']],
        ['setLinkInfo', [`${CENTRAL}:1`, channel, 'sweep', 'renamed']],
        ['getLinkInfo', [`${CENTRAL}:1`, channel]],
        ['activateLinkParamset', [channel, `${CENTRAL}:1`, false]],
        ['removeLink', [`${CENTRAL}:1`, channel]],
        ['setMetadata', [device, 'sweep', 'value']],
        ['getMetadata', [device, 'sweep']],
        ['getAllMetadata', [device]],
        ['setVolatileMetadata', ['sweep', 'value']],
        ['hasVolatileMetadata', ['sweep']],
        ['getVolatileMetadata', ['sweep']],
        ['deleteVolatileMetadata', ['sweep']],
        ['setTeam', [channel, '']],
        ['listReplaceableDevices', [device]],
        ['getKeyMismatchDevice', [false]],
        ['setInstallMode', [false]],
        ['setInstallMode', [true, 1, 1]],
        ['setInstallMode', [false, 0, UNKNOWN]],
        ['setBidcosInterface', [device, moduleSerial, false]],
        ['setInterfaceClock', [0, 0]],
        ['setRFLGWInfoLED', [0]],
        ['clearConfigCache', [device]],
        ['restoreConfigToDevice', [device]],
        ['updateFirmware', [UNKNOWN]],
        ['ping', ['sweep']],
        ['init', [receiverUrl, 'sweep']],
        ['changeKey', ['sweep-passphrase']],
        ['setTempKey', ['sweep-passphrase']],
        ['addDevice', [UNKNOWN]],
        ['abortDeleteDevice', [UNKNOWN]],
        ['addVirtualDeviceInstance', [[]]],
        ['replaceDevice', [device, UNKNOWN]],
        ['deleteDevice', [device, 2]],
    ];
}

test(
    'method sweep: system.listMethods of rfd is the dispatcher table of its source (a method added or removed upstream shows here)',
    {...skipWithoutDaemons, timeout: 120000},
    async (t) => {
        const table = readMethodTable('rfd');
        if (!table) {
            t.skip('no dispatcher table in the image (HMRS_METHODS)');
            return;
        }
        const rfd = await startRfd();
        await withDaemon(rfd, async () => {
            const listed = (await rfd.call('system.listMethods')).filter((m) => !m.startsWith('system.')).sort();
            assert.deepEqual(listed, table);
            t.diagnostic(`${table.length} methods`);
        });
    },
);

test(
    'method sweep: every rfd method with valid, missing, extra and wrong-typed arguments; rfd stays up, no sanitizer report',
    {...skipWithoutDaemons, timeout: 900000},
    async (t) => {
        const table = readMethodTable('rfd');
        const rfd = await startSweepRfd();
        const caller = new SweepCaller(rfd, {skip: skipKnown});
        await withDaemon(rfd, async () => {
            const description = loadDeviceDescription(path.join(RFTYPES, SWITCH_FILE));
            const device = 'SWPMETH001';
            const added = await rfd.call('addVirtualDeviceInstance', [
                [...announcement(description, SWITCH_TYPE, 0x4f0001, device)],
            ]);
            assert.equal(added, true, 'the virtual switch the sweep calls on');
            const calls = rfdCalls({
                device,
                channel: `${device}:1`,
                moduleSerial: rfd.module.serial,
                // nobody listens there: rfd's callbacks to it fail, as for a logic layer that went away
                receiverUrl: 'xmlrpc_bin://127.0.0.1:9',
            });
            const swept = new Set();
            for (const [method, params] of calls) {
                await caller.sweep(method, params);
                swept.add(method);
                assert.ok(rfd.alive, `rfd died in the sweep of ${method}: ${JSON.stringify(rfd.exit)}`);
            }
            // the rest of the table (never `exit`: it stops rfd - the restart tests use it) without arguments
            for (const method of (table || []).filter((m) => !swept.has(m) && m !== 'exit')) {
                await caller.sweep(method, []);
                swept.add(method);
            }
            assert.ok(rfd.alive, `rfd died: ${JSON.stringify(rfd.exit)}`);
            assert.ok(Array.isArray(await rfd.call('listDevices')), 'rfd still answers');
            assert.deepEqual(rfd.sanitizerReports(), []);
            if (table) {
                assert.deepEqual(
                    table.filter((m) => !swept.has(m) && m !== 'exit'),
                    [],
                    'every method of the table was swept',
                );
            }
            t.diagnostic(
                `${caller.calls} calls over ${swept.size} methods; timeouts: ${caller.timeouts.join(' ') || 'none'}`,
            );
            writeRecord('rfd-methods', caller.record);
        }).finally(() => caller.close());
    },
);

test(
    'device-type sweep: one virtual instance of every rftypes type; descriptions, paramsets and values of every device and channel',
    {...skipWithoutDaemons, timeout: 1800000},
    async (t) => {
        const rfd = await startSweepRfd();
        const caller = new SweepCaller(rfd);
        const types = allTypes();
        const record = {};
        const notAdded = [];
        const otherType = [];
        const skipped = [];
        await withDaemon(rfd, async () => {
            let i = 0;
            for (const {file, description, typeId} of types) {
                i++;
                const serial = `SWT${String(i).padStart(7, '0')}`;
                const address = 0x500000 + i;
                const key = `${file}/${typeId}`;
                if (isKnownBroken('string-uint-conversion') && usesStringUint(file)) {
                    record[key] = {added: 'skipped (the string-uint-conversion finding)'};
                    skipped.push(key);
                    continue;
                }
                const added = await caller.call(
                    'addVirtualDeviceInstance',
                    [[...announcement(description, typeId, address, serial)]],
                    {label: key},
                );
                if (added.result !== true) {
                    notAdded.push(key);
                    record[key] = {added: added.summary};
                    continue;
                }
                const entry = {};
                const top = await caller.call('getDeviceDescription', [serial], {label: `${key}`});
                const desc = top.result || {};
                entry.type = desc.TYPE;
                if (desc.TYPE !== typeId) {
                    otherType.push(`${typeId}->${desc.TYPE}`);
                }
                const addresses = [serial, ...(desc.CHILDREN || [])];
                entry.channels = (desc.CHILDREN || []).length;
                entry.addresses = {};
                for (const address of addresses) {
                    const suffix = address === serial ? '' : address.slice(serial.length);
                    const a = {};
                    const d = address === serial ? desc : (await caller.call('getDeviceDescription', [address])).result;
                    a.description = summarize(d);
                    a.channelType = d && d.TYPE;
                    for (const key of ['MASTER', 'VALUES', 'LINK']) {
                        const ps = await caller.call('getParamsetDescription', [address, key]);
                        a[key] =
                            ps.result && typeof ps.result === 'object' && !('faultCode' in ps.result)
                                ? Object.keys(ps.result)
                                      .sort()
                                      .map((name) => `${name}:${ps.result[name].TYPE}`)
                                : ps.summary;
                        if (key !== 'LINK') {
                            a[`${key}-values`] = (await caller.call('getParamset', [address, key])).summary;
                        }
                        if (key === 'VALUES' && Array.isArray(a.VALUES)) {
                            for (const name of Object.keys(ps.result)) {
                                if (ps.result[name].OPERATIONS & 1) {
                                    await caller.call('getValue', [address, name]);
                                }
                            }
                        }
                    }
                    entry.addresses[suffix || 'device'] = a;
                }
                record[key] = entry;
                if (!rfd.alive) {
                    break;
                }
            }
            assert.ok(rfd.alive, `rfd died in the type sweep after ${i} types: ${JSON.stringify(rfd.exit)}`);
            assert.deepEqual(rfd.sanitizerReports(), []);
            const devices = await rfd.call('listDevices', [], {timeout: 60000});
            t.diagnostic(
                `${types.length} types, ${types.length - notAdded.length - skipped.length} instantiated, ${skipped.length} skipped for a known finding, ${devices.length} addresses listed, ${caller.calls} calls; timeouts: ${caller.timeouts.length}`,
            );
            t.diagnostic(`not instantiated: ${notAdded.join(' ') || 'none'}`);
            t.diagnostic(`matched as another type: ${otherType.join(' ') || 'none'}`);
            // a type rfd cannot instantiate from its own announcement is a broken description or a broken match
            assert.ok(
                notAdded.length <= types.length * 0.1,
                `${notAdded.length} of ${types.length} types not instantiated: ${notAdded.join(' ')}`,
            );
            writeRecord('rfd-types', record);
        }).finally(() => caller.close());
    },
);

test(
    'metadata methods with a missing argument fault, rfd stays up, no sanitizer report (the metadata-args finding)',
    {...skipWithoutDaemons, ...regression('metadata-args'), timeout: 120000},
    async (t) => {
        // XmlRpcMethods.cpp: `const char* dataId = ((std::string&)params[0]).c_str(); ... params[1]` - indexing the
        // missing second argument grows the array and frees the string under dataId (heap-use-after-free under ASan)
        const rfd = await startSweepRfd();
        const caller = new SweepCaller(rfd);
        await withDaemon(rfd, async () => {
            for (const [method, params] of [
                ['setVolatileMetadata', []],
                ['setVolatileMetadata', ['sweep']],
                ['getMetadata', [CENTRAL]],
                ['setMetadata', [CENTRAL, 'sweep']],
            ]) {
                const {summary} = await caller.call(method, params);
                t.diagnostic(`${method}(${params.join(', ')}): ${summary}`);
                assert.ok(rfd.alive, `rfd died on ${method}(${params.join(', ')}): ${JSON.stringify(rfd.exit)}`);
            }
            assert.deepEqual(rfd.sanitizerReports(), []);
        }).finally(() => caller.close());
    },
);

test(
    'a device type with type_conversion_string_unsigned_integer (HM-OU-LED16) is instantiated without a sanitizer report (the string-uint-conversion finding)',
    {...skipWithoutDaemons, ...regression('string-uint-conversion'), timeout: 120000},
    async (t) => {
        // libhsscomm HSSTypeConversionStringUnsignedInteger::LogicalToPhysical walks the c_str() of a destroyed
        // temporary string; rfd runs it when it sets up the channels (stack-use-after-scope under ASan)
        const rfd = await startSweepRfd();
        await withDaemon(rfd, async () => {
            const file = fs
                .readdirSync(RFTYPES)
                .filter((f) => f.endsWith('.xml'))
                .sort()
                .find((f) => usesStringUint(f));
            assert.ok(file, 'a description with the conversion in the image');
            const description = loadDeviceDescription(path.join(RFTYPES, file));
            const typeId = description.types[0].id;
            const added = await rfd.call('addVirtualDeviceInstance', [
                [...announcement(description, typeId, 0x4f0002, 'SWPLED1601')],
            ]);
            t.diagnostic(`${file} ${typeId}: added ${added}`);
            assert.ok(rfd.alive, `rfd died: ${JSON.stringify(rfd.exit)}`);
            assert.equal(added, true);
            assert.ok((await rfd.call('getDeviceDescription', ['SWPLED1601'])).CHILDREN.length > 0);
            assert.deepEqual(rfd.sanitizerReports(), []);
        });
    },
);
