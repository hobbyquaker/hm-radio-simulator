/**
 * The differential of the sweeps: every daemon job of the release variant leaves the records of the RPC method sweep
 * and the device-type sweep (results/<variant>/sweep/<name>.json, test/helpers/sweep.js); the report compares them
 *
 *   - between the refs of one run (3.89.11 against main): what a consumer sees change between the release and the
 *     upstream head;
 *   - between main now and main as the previous published report tested it (the upstream watch, task 14), when the
 *     OpenCCU-Base commit changed in between.
 *
 * A record is a nested object of short answer summaries; it is flattened to "path -> text" and compared key by key.
 * DIFF_IGNORE lists the keys whose answers name a version and so differ by design.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Keys (flattened paths) whose answers differ between refs by design. */
export const DIFF_IGNORE = Object.freeze([/^getVersion\(/]);

/** The most changes a section lists; the counts are always complete. */
export const DIFF_LIST_LIMIT = 200;

/** Reads results/<variant>/sweep/*.json into {name: record}, or null when there are none. */
export function readSweep(dir) {
    const sweepDir = path.join(dir, 'sweep');
    if (!fs.existsSync(sweepDir)) {
        return null;
    }
    const out = {};
    for (const file of fs
        .readdirSync(sweepDir)
        .filter((f) => f.endsWith('.json'))
        .sort()) {
        try {
            out[file.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(sweepDir, file), 'utf8'));
        } catch {
            // a record cut short by a crashed run is no record
        }
    }
    return Object.keys(out).length ? out : null;
}

/**
 * Flattens a record: nested objects become "a / b / c" paths, arrays a comma-separated text.
 * @param {object} record
 * @returns {Map<string, string>}
 */
export function flatten(record, prefix = '', out = new Map()) {
    for (const [key, value] of Object.entries(record || {})) {
        const p = prefix ? `${prefix} / ${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            flatten(value, p, out);
        } else {
            out.set(p, Array.isArray(value) ? value.join(', ') : String(value));
        }
    }
    return out;
}

/**
 * Compares two sets of sweep records ({name: record}).
 * @returns {{added: number, removed: number, changed: number, equal: number, ignored: number,
 *   items: Array<{sweep: string, key: string, from: string|null, to: string|null}>}}
 */
export function diffSweeps(from, to, ignore = DIFF_IGNORE) {
    const result = {added: 0, removed: 0, changed: 0, equal: 0, ignored: 0, items: []};
    const names = [...new Set([...Object.keys(from || {}), ...Object.keys(to || {})])].sort();
    for (const name of names) {
        const a = flatten((from || {})[name]);
        const b = flatten((to || {})[name]);
        const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
        for (const key of keys) {
            if (ignore.some((re) => re.test(key))) {
                result.ignored++;
                continue;
            }
            const x = a.has(key) ? a.get(key) : null;
            const y = b.has(key) ? b.get(key) : null;
            if (x === y) {
                result.equal++;
                continue;
            }
            if (x === null) {
                result.added++;
            } else if (y === null) {
                result.removed++;
            } else {
                result.changed++;
            }
            result.items.push({sweep: name, key, from: x, to: y});
        }
    }
    return result;
}

/**
 * The differential sections of a run.
 * @param {Array<{ref: string, variant: string, baseCommit: string, sweep?: object}>} jobs
 * @param {{ref: string, baseCommit: string, records: object}|null} previousMain the main records of the published
 *   report before this run
 * @returns {Array<{title: string, from: {ref: string, baseCommit: string}, to: {ref: string, baseCommit: string},
 *   diff: ReturnType<typeof diffSweeps>}>}
 */
export function buildDifferential(jobs, previousMain = null) {
    const sections = [];
    const release = jobs.filter((j) => j.variant === 'release' && j.sweep);
    const main = release.find((j) => j.ref === 'main');
    for (const job of release.filter((j) => j.ref !== 'main')) {
        if (main) {
            sections.push({
                title: `${job.ref} → main`,
                from: {ref: job.ref, baseCommit: job.baseCommit},
                to: {ref: 'main', baseCommit: main.baseCommit},
                diff: diffSweeps(job.sweep, main.sweep),
            });
        }
    }
    if (main && previousMain && previousMain.records && previousMain.baseCommit !== main.baseCommit) {
        sections.push({
            title: 'main: the previously tested commit → this one',
            from: {ref: 'main', baseCommit: previousMain.baseCommit},
            to: {ref: 'main', baseCommit: main.baseCommit},
            diff: diffSweeps(previousMain.records, main.sweep),
        });
    }
    return sections;
}
