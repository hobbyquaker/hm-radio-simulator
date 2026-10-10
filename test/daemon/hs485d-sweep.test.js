/**
 * The sweeps over hs485d: the RPC method sweep against the HMW-LGW in JavaScript with one discovered wired switch,
 * and the device-type sweep - one wired device of every hs485types type on the simulated bus, discovered by
 * `searchDevices`, then the descriptions, paramsets and values of every device and channel. Both record a summary of
 * every answer for the differential (see rfd-sweep.test.js). hs485d's port is fixed at 2000: one daemon at a time.
 *
 * Timing assumptions (hs485d 3.89.11): the gateway answers within HS485_RESPONSE_TIMEOUT = 700 ms (the bus in 20 ms);
 * a discovery collects answers for 3 x 700 ms plus the per-device reads (`h`, `v`, `n`, the EEPROM) - generous
 * timeouts of a minute and more for `searchDevices`.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {startHs485d, withDaemon, skipWithoutDaemons, HS485TYPES} from '../helpers/daemon.js';
import {startReceiver} from '../helpers/rpc.js';
import {SweepCaller, readMethodTable, writeRecord, summarize} from '../helpers/sweep.js';
import {loadDeviceDescription, sysinfoSatisfying} from '../../lib/rftypes.js';
import {WiredBus, WiredDevice} from '../../lib/wired.js';

const UNKNOWN = 'NOSUCH0001';
const SERIAL = 'SWPWIRE001';
const TYPE = 'HMW-LC-Sw2-DR';

function wiredDescription(file) {
    return loadDeviceDescription(path.join(HS485TYPES, file));
}

/** hs485d through the JavaScript gateway with `devices` on the bus and a receiver registered. */
async function setup(devices) {
    const bus = new WiredBus();
    for (const d of devices) {
        bus.add(d);
    }
    const hs485d = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus});
    const receiver = await startReceiver();
    await hs485d.call('init', [receiver.url, 'hmrs', false]);
    return {hs485d, receiver, bus};
}

test(
    'method sweep: system.listMethods of hs485d is the dispatcher table of its source',
    {...skipWithoutDaemons, timeout: 120000},
    async (t) => {
        const table = readMethodTable('hs485d');
        if (!table) {
            t.skip('no dispatcher table in the image (HMRS_METHODS)');
            return;
        }
        const {hs485d, receiver} = await setup([]);
        await withDaemon(hs485d, async () => {
            const listed = (await hs485d.call('system.listMethods')).filter((m) => !m.startsWith('system.')).sort();
            assert.deepEqual(listed, table);
            t.diagnostic(`${table.length} methods`);
        }).finally(() => receiver.stop());
    },
);

test(
    'method sweep: every hs485d method with valid, missing, extra and wrong-typed arguments; hs485d stays up, no sanitizer report',
    {...skipWithoutDaemons, timeout: 900000},
    async (t) => {
        const table = readMethodTable('hs485d');
        const sw = new WiredDevice({
            address: 0x00004711,
            serial: SERIAL,
            description: wiredDescription('hmw_lc_sw2_dr.xml'),
            typeId: TYPE,
            sysinfo: [0x11, 0x00, 0x03, 0x05],
        });
        const {hs485d, receiver} = await setup([sw]);
        const caller = new SweepCaller(hs485d);
        await withDaemon(hs485d, async () => {
            assert.equal(await hs485d.call('searchDevices', [], {timeout: 60000}), 1, 'the switch is found');
            const channel = `${SERIAL}:3`;
            const key = `${SERIAL}:1`;
            const calls = [
                ['listDevices', []],
                ['getLGWStatus', []],
                ['logLevel', []],
                ['getDeviceDescription', [SERIAL]],
                ['getParamsetDescription', [channel, 'MASTER']],
                ['getParamsetDescription', [channel, 'VALUES']],
                ['getParamsetDescription', [channel, 'LINK']],
                ['getParamsetId', [channel, 'MASTER']],
                ['getParamset', [SERIAL, 'MASTER']],
                ['getParamset', [channel, 'VALUES']],
                ['getValue', [channel, 'STATE']],
                ['getValue', [`${UNKNOWN}:1`, 'STATE']],
                ['setValue', [channel, 'STATE', true]],
                ['putParamset', [channel, 'MASTER', {}]],
                ['reportValueUsage', [channel, 'STATE', 1]],
                ['getLinkPeers', [channel]],
                ['getLinks', [channel, 0]],
                ['addLink', [key, channel, 'sweep', 'a sweep link']],
                ['setLinkInfo', [key, channel, 'sweep', 'renamed']],
                ['getLinkInfo', [key, channel]],
                ['removeLink', [key, channel]],
                ['clearConfigCache', [SERIAL]],
                ['listReplaceableDevices', [SERIAL]],
                ['ping', ['sweep']],
                ['init', ['xmlrpc_bin://127.0.0.1:9', 'sweep']],
                ['updateFirmware', [UNKNOWN]],
                ['replaceDevice', [SERIAL, UNKNOWN]],
                ['deleteDevice', [SERIAL, 0]],
            ];
            const swept = new Set();
            for (const [method, params] of calls) {
                await caller.sweep(method, params);
                swept.add(method);
                assert.ok(hs485d.alive, `hs485d died in the sweep of ${method}: ${JSON.stringify(hs485d.exit)}`);
            }
            for (const method of (table || []).filter((m) => !swept.has(m))) {
                await caller.sweep(method, []);
                swept.add(method);
            }
            assert.ok(hs485d.alive, `hs485d died: ${JSON.stringify(hs485d.exit)}`);
            assert.ok(Array.isArray(await hs485d.call('listDevices')), 'hs485d still answers');
            assert.deepEqual(hs485d.sanitizerReports(), []);
            if (table) {
                assert.deepEqual(
                    table.filter((m) => !swept.has(m)),
                    [],
                    'every method of the table was swept',
                );
            }
            t.diagnostic(
                `${caller.calls} calls over ${swept.size} methods; timeouts: ${caller.timeouts.join(' ') || 'none'}`,
            );
            writeRecord('hs485d-methods', caller.record);
        }).finally(async () => {
            caller.close();
            await receiver.stop();
        });
    },
);

test(
    'device-type sweep: one wired device of every hs485types type, discovered; descriptions, paramsets and values',
    {...skipWithoutDaemons, timeout: 900000},
    async (t) => {
        const devices = [];
        const wanted = [];
        let i = 0;
        for (const file of fs
            .readdirSync(HS485TYPES)
            .filter((f) => f.endsWith('.xml'))
            .sort()) {
            const description = wiredDescription(file);
            for (const type of description.types) {
                // a type without a condition (the central, the generic fallback) matches anything: nothing to announce
                if (!type.conditions.some((c) => c.index)) {
                    continue;
                }
                i++;
                const serial = `SWW${String(i).padStart(7, '0')}`;
                const sysinfo = sysinfoSatisfying(description, type.id, Buffer.alloc(4));
                devices.push(new WiredDevice({address: 0x00005000 + i, serial, description, typeId: type.id, sysinfo}));
                wanted.push({key: `${file}/${type.id}`, serial, typeId: type.id});
            }
        }
        const {hs485d, receiver} = await setup(devices);
        const caller = new SweepCaller(hs485d, {timeout: 30000});
        const record = {};
        const missing = [];
        const otherType = [];
        await withDaemon(hs485d, async () => {
            const found = await hs485d.call('searchDevices', [], {timeout: 300000});
            t.diagnostic(`searchDevices found ${found} of ${devices.length}`);
            for (const {key, serial, typeId} of wanted) {
                const top = await caller.call('getDeviceDescription', [serial], {label: key});
                const desc = top.result;
                if (!desc || typeof desc !== 'object' || 'faultCode' in desc) {
                    missing.push(key);
                    record[key] = {found: top.summary};
                    continue;
                }
                if (desc.TYPE !== typeId) {
                    otherType.push(`${typeId}->${desc.TYPE}`);
                }
                const entry = {type: desc.TYPE, channels: (desc.CHILDREN || []).length, addresses: {}};
                for (const address of [serial, ...(desc.CHILDREN || [])]) {
                    const a = {};
                    const d = address === serial ? desc : (await caller.call('getDeviceDescription', [address])).result;
                    a.description = summarize(d);
                    a.channelType = d && d.TYPE;
                    for (const psKey of ['MASTER', 'VALUES', 'LINK']) {
                        const ps = await caller.call('getParamsetDescription', [address, psKey]);
                        const ok = ps.result && typeof ps.result === 'object' && !('faultCode' in ps.result);
                        a[psKey] = ok
                            ? Object.keys(ps.result)
                                  .sort()
                                  .map((name) => `${name}:${ps.result[name].TYPE}`)
                            : ps.summary;
                        if (psKey !== 'LINK') {
                            a[`${psKey}-values`] = (await caller.call('getParamset', [address, psKey])).summary;
                        }
                        if (psKey === 'VALUES' && ok) {
                            for (const name of Object.keys(ps.result)) {
                                if (ps.result[name].OPERATIONS & 1) {
                                    await caller.call('getValue', [address, name]);
                                }
                            }
                        }
                    }
                    entry.addresses[address === serial ? 'device' : address.slice(serial.length)] = a;
                }
                record[key] = entry;
                if (!hs485d.alive) {
                    break;
                }
            }
            assert.ok(hs485d.alive, `hs485d died in the type sweep: ${JSON.stringify(hs485d.exit)}`);
            assert.deepEqual(hs485d.sanitizerReports(), []);
            t.diagnostic(`not found: ${missing.join(' ') || 'none'}`);
            t.diagnostic(`matched as another type: ${otherType.join(' ') || 'none'}`);
            t.diagnostic(`${caller.calls} calls; timeouts: ${caller.timeouts.length}`);
            assert.deepEqual(missing, [], 'every wired type is discovered and described');
            writeRecord('hs485d-types', record);
        }).finally(async () => {
            caller.close();
            await receiver.stop();
        });
    },
);
