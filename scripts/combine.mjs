/**
 * One result per OpenCCU-Base ref instead of one per job: the release, ASan and coverage variants of a ref usually
 * agree, and only where they differ is that worth a look. scripts/report.mjs renders what this computes.
 *
 * - A ref's result is the worst of its variants (fail > todo > skip > pass).
 * - The coverage variant counts only where it differs from release (its purpose is the coverage numbers).
 * - `differs` is true when the counted variants do not all agree; the chips name the variants that have the shown
 *   (worst) result, e.g. "A" when only ASan fails.
 */

import {compareRefs} from './refs.mjs';

export const VARIANT_ORDER = Object.freeze(['release', 'asan', 'coverage', 'tsan']);
export const VARIANT_CHIP = Object.freeze({release: 'R', asan: 'A', coverage: 'C', tsan: 'T'});
const RANK = {pass: 0, skip: 1, todo: 2, fail: 3};

/** The worse of two statuses. */
export function worse(a, b) {
    return (RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b;
}

/**
 * The refs of a run, oldest tag first, each with its jobs in variant order.
 * @param {Array<{id: string, ref: string, variant: string, baseCommit: string}>} jobs
 * @returns {Array<{ref: string, baseCommit: string, jobs: object[]}>}
 */
export function groupByRef(jobs) {
    const refs = new Map();
    for (const job of jobs) {
        if (!refs.has(job.ref)) {
            refs.set(job.ref, {ref: job.ref, baseCommit: job.baseCommit, jobs: []});
        }
        refs.get(job.ref).jobs.push(job);
    }
    const order = (v) => VARIANT_ORDER.indexOf(v) + 1 || 9;
    for (const r of refs.values()) {
        r.jobs.sort((a, b) => order(a.variant) - order(b.variant));
    }
    return [...refs.values()].sort((a, b) => compareRefs(a.ref, b.ref));
}

/**
 * A test's combined result on one ref.
 * @param {Map<string, object>} results job id -> the test's result in that job
 * @param {{jobs: object[]}} ref
 * @returns {{status: string|null, differs: boolean, chips: string[], variants: Array<{variant: string, status: string,
 *   durationMs: number, todo?: unknown, skip?: unknown, error?: string, diagnostics?: string[]}>}|null} null when the
 *   test did not run on that ref at all
 */
export function combine(results, ref) {
    const variants = [];
    for (const job of ref.jobs) {
        const r = results.get(job.id);
        if (r) {
            variants.push({variant: job.variant, ...r});
        }
    }
    if (!variants.length) {
        return null;
    }
    const release = variants.find((v) => v.variant === 'release');
    // the coverage variant counts only where it differs from release
    const counted = variants.filter((v) => v.variant !== 'coverage' || !release || v.status !== release.status);
    const status = counted.reduce((s, v) => worse(s, v.status), 'pass');
    const differs = new Set(counted.map((v) => v.status)).size > 1;
    const chips = differs
        ? counted.filter((v) => v.status === status).map((v) => VARIANT_CHIP[v.variant] || v.variant)
        : [];
    return {status, differs, chips, variants};
}

/**
 * Per ref the counts of the combined results over all test rows, plus each variant's own job counts and duration.
 * @param {Array<{results: Map<string, object>}>} rows
 * @param {Array<{ref: string, jobs: object[]}>} refs
 */
export function refCounts(rows, refs) {
    return refs.map((ref) => {
        const counts = {pass: 0, fail: 0, todo: 0, skip: 0};
        let differing = 0;
        for (const row of rows) {
            const c = combine(row.results, ref);
            if (c) {
                counts[c.status] = (counts[c.status] || 0) + 1;
                differing += c.differs ? 1 : 0;
            }
        }
        return {ref, counts, differing};
    });
}
