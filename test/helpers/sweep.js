/**
 * The RPC and device-type sweeps (task "sweeps and the differential"): call every method of a daemon with valid,
 * missing and wrong-typed arguments, record a short, deterministic summary of every answer, and write the records
 * next to the test results, where the report diffs them between OpenCCU-Base refs (scripts/report.mjs).
 *
 * A summary keeps what a consumer relies on - the answer's type, a struct's keys, an array's length and the first
 * element's shape, a fault's code and text - and drops what changes from run to run (nothing of that kind is in the
 * answers of a fresh daemon with fixed addresses and serials, so the records of two runs of one ref are equal).
 */

import fs from 'node:fs';
import path from 'node:path';

import {BinRpcClient} from './rpc.js';
import {sysinfoSatisfying, loadDeviceDescription} from '../../lib/rftypes.js';
import {RFTYPES} from './daemon.js';
import {encodeTelegram, FT} from '../../lib/telegram.js';

/** Where the image keeps the dispatcher tables (scripts/method-table.mjs, run at image-build time). */
export const METHODS_DIR = process.env.HMRS_METHODS || '/opt/openccu-base/methods';

/**
 * The values every argument position is replaced with in turn: each BIN-RPC type once, plus the edges a careless
 * conversion trips over (a negative and the largest integer, a long string).
 */
export const WRONG_VALUES = Object.freeze([
    {label: 'int0', value: 0},
    {label: 'int-1', value: -1},
    {label: 'intmax', value: 2147483647},
    {label: 'double', value: 1.5},
    {label: 'bool', value: true},
    {label: 'string', value: 'x'},
    {label: 'string2k', value: 'A'.repeat(2048)},
    {label: 'array', value: []},
    {label: 'struct', value: {}},
]);

/** The dispatcher table of a daemon from the image, or null outside it. */
export function readMethodTable(daemon) {
    const file = path.join(METHODS_DIR, `${daemon}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/**
 * A short, deterministic description of an RPC answer.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string}
 */
export function summarize(value, depth = 0) {
    if (value === null || value === undefined) {
        return 'nil';
    }
    if (Array.isArray(value)) {
        if (depth > 0 || value.length === 0) {
            return `array[${value.length}]`;
        }
        return `array[${value.length}] of ${summarize(value[0], 1)}`;
    }
    if (Buffer.isBuffer(value)) {
        return `binary(${value.length})`;
    }
    if (typeof value === 'object') {
        if ('faultCode' in value) {
            return `fault ${value.faultCode} ${String(value.faultString ?? '').slice(0, 120)}`;
        }
        const keys = Object.keys(value).sort();
        return depth > 0 ? `struct{${keys.length}}` : `struct{${keys.join(',')}}`;
    }
    if (typeof value === 'string') {
        return value.length > 60 ? `string(${value.length})` : `string ${JSON.stringify(value)}`;
    }
    return `${typeof value} ${value}`;
}

/** A label for an argument list, short enough for a record key. */
export function argsLabel(params) {
    return params
        .map((p) => {
            if (typeof p === 'string') {
                return p.length > 24 ? `"${p.slice(0, 8)}…"(${p.length})` : JSON.stringify(p);
            }
            if (Array.isArray(p)) {
                return `[${p.length}]`;
            }
            if (p && typeof p === 'object') {
                return 'explicitDouble' in p ? String(p.explicitDouble) : `{${Object.keys(p).join(',')}}`;
            }
            return String(p);
        })
        .join(', ');
}

/**
 * Calls one daemon method after the other on its own connection; a call that does not answer in time gets a fresh
 * connection, so a late answer cannot be taken for the next call's.
 */
export class SweepCaller {
    /**
     * @param {import('./daemon.js').Daemon} daemon
     * @param {{timeout?: number, skip?: (method: string, params: any[]) => string|null}} [options] `skip` names a
     *   known finding a call would trip (a crash under ASan) - the call is then recorded as skipped, not made
     */
    constructor(daemon, {timeout = 15000, skip = () => null} = {}) {
        this.daemon = daemon;
        this.timeout = timeout;
        this.skip = skip;
        this.client = new BinRpcClient(daemon.port);
        /** @type {Record<string, string>} key "method(args)" -> summary */
        this.record = {};
        this.calls = 0;
        this.timeouts = [];
    }

    /**
     * @param {string} method
     * @param {any[]} params
     * @param {{timeout?: number, label?: string}} [options]
     * @returns {Promise<{summary: string, result?: any}>}
     */
    async call(method, params, {timeout = this.timeout, label} = {}) {
        this.calls++;
        const key = `${method}(${label ?? argsLabel(params)})`;
        const finding = this.skip(method, params);
        if (finding) {
            this.record[key] = `skipped (the ${finding} finding)`;
            return {summary: this.record[key]};
        }
        let summary;
        let result;
        try {
            result = await this.client.call(method, params, {timeout});
            summary = summarize(result);
        } catch (error) {
            if (/no answer within|response timeout/.test(error.message)) {
                summary = 'timeout';
                this.timeouts.push(key);
                this.client.client.close();
                this.client = new BinRpcClient(this.daemon.port);
            } else if (error && typeof error === 'object' && 'faultCode' in error) {
                summary = summarize(error);
            } else {
                summary = `error ${error.code || error.message}`.slice(0, 120);
            }
        }
        this.record[key] = summary;
        return {summary, result};
    }

    /**
     * The valid call, then the call without arguments, with one extra argument, and with every argument replaced by
     * each of WRONG_VALUES in turn.
     */
    async sweep(method, valid) {
        await this.call(method, valid);
        if (valid.length > 0) {
            await this.call(method, []);
        }
        await this.call(method, [...valid, 'extra']);
        for (let i = 0; i < valid.length; i++) {
            for (const wrong of WRONG_VALUES) {
                const params = valid.slice();
                params[i] = wrong.value;
                await this.call(method, params, {
                    label: argsLabel(valid.slice(0, i)) + `${i ? ', ' : ''}<${wrong.label}>`,
                });
            }
        }
    }

    close() {
        this.client.client.close();
    }
}

/**
 * Writes a sweep record where the report finds it: results/<variant>/sweep/<name>.json (HMRS_WORKDIR is
 * results/<variant>/work in the image). Outside the image the record is not written.
 * @param {string} name e.g. "rfd-methods"
 * @param {object} data
 */
export function writeRecord(name, data) {
    const work = process.env.HMRS_WORKDIR;
    if (!work) {
        return null;
    }
    const dir = path.join(path.dirname(work), 'sweep');
    fs.mkdirSync(dir, {recursive: true});
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 1) + '\n');
    return file;
}

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

/** The descriptions that use type_conversion_string_unsigned_integer (the string-uint-conversion finding). */
export function usesStringUint(file) {
    return fs.readFileSync(path.join(RFTYPES, file), 'latin1').includes('"string_unsigned_integer"');
}

/** Every type of every rftypes file, in a fixed order. */
export function allTypes() {
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
