/**
 * The differential of the sweeps: every daemon job of the release variant leaves the records of the RPC method sweep
 * and the device-type sweep (results/<variant>/sweep/<name>.json, test/helpers/sweep.js); the report compares them
 *
 *   - between neighbouring upstream refs of one run (the release tag against main, older tags against newer ones when
 *     a run has several): what a consumer sees change from the release up to the upstream head; each fork ref
 *     (scripts/refs.mjs FORK_REFS: openccu-lite's tag and branch) against the run's newest upstream release tag;
 *   - between main now and main as the previous published report tested it (the upstream watch, task 14), when the
 *     OpenCCU-Base commit changed in between.
 *
 * A record is a nested object of short answer summaries; it is flattened to "path -> text" and compared key by key.
 * DIFF_IGNORE lists the keys whose answers name a version and so differ by design.
 */

import fs from 'node:fs';
import path from 'node:path';

import {compareRefs, forkOf, refPairText, refText, FORK_REFS, RELEASE_TAG} from './refs.mjs';

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
export function buildDifferential(jobs, previousMain = null, forks = FORK_REFS) {
    const sections = [];
    // neighbours in the report's order among the upstream refs: oldest tag -> newer tag -> main; a fork ref against
    // the newest upstream release tag of the run (what its picked and own fixes change)
    const all = jobs.filter((j) => j.variant === 'release' && j.sweep).sort((a, b) => compareRefs(a.ref, b.ref, forks));
    const fork = (ref) => forkOf(ref, forks);
    const release = all.filter((j) => !fork(j.ref));
    const newestTag = release.filter((j) => RELEASE_TAG.test(j.ref)).pop();
    const main = release.find((j) => j.ref === 'main');
    for (let i = 0; i + 1 < release.length; i++) {
        const [from, to] = [release[i], release[i + 1]];
        sections.push({
            title: refPairText(from.ref, to.ref, forks),
            from: {ref: from.ref, baseCommit: from.baseCommit},
            to: {ref: to.ref, baseCommit: to.baseCommit},
            diff: diffSweeps(from.sweep, to.sweep),
        });
    }
    for (const to of all.filter((j) => fork(j.ref))) {
        const from = newestTag;
        if (from) {
            sections.push({
                title: refPairText(from.ref, to.ref, forks),
                from: {ref: from.ref, baseCommit: from.baseCommit},
                to: {ref: to.ref, baseCommit: to.baseCommit},
                diff: diffSweeps(from.sweep, to.sweep),
            });
        }
    }
    if (main && previousMain && previousMain.records && previousMain.baseCommit !== main.baseCommit) {
        sections.push({
            title: `${refText('main', forks)}: the previously tested commit → this one`,
            from: {ref: 'main', baseCommit: previousMain.baseCommit},
            to: {ref: 'main', baseCommit: main.baseCommit},
            diff: diffSweeps(previousMain.records, main.sweep),
        });
    }
    return sections;
}
