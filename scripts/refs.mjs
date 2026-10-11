/**
 * The OpenCCU-Base refs of a run: their order on the report and the derivation of their known-broken lists
 * (scripts/resolve-refs.mjs picks the refs; scripts/report.mjs and scripts/differential.mjs order them).
 */

import {UPSTREAM_FIXES, FINDINGS} from '../test/metadata.js';

export const VARIANTS = Object.freeze(['release', 'asan', 'coverage']);
export const RELEASE_TAG = /^\d+(\.\d+)+$/;

/** Orders refs as the report shows them: release tags by version, oldest first, then anything else, main last. */
export function compareRefs(a, b) {
    const rank = (r) => (r === 'main' ? 2 : RELEASE_TAG.test(r) ? 0 : 1);
    if (rank(a) !== rank(b)) {
        return rank(a) - rank(b);
    }
    if (rank(a) === 0) {
        const x = a.split('.').map(Number);
        const y = b.split('.').map(Number);
        for (let i = 0; i < Math.max(x.length, y.length); i++) {
            if ((x[i] || 0) !== (y[i] || 0)) {
                return (x[i] || 0) - (y[i] || 0);
            }
        }
        return 0;
    }
    return a.localeCompare(b);
}

/**
 * The harnesses with a known finding of this suite on a ref: "harness=finding,..." for FUZZ_KNOWN_HARNESSES.
 * @param {string[]} known the ref's known-broken list
 */
export function knownHarnesses(known, findings = FINDINGS) {
    return Object.entries(findings)
        .filter(([name, f]) => f.fuzzHarness && known.includes(name))
        .map(([name, f]) => `${f.fuzzHarness}=${name}`)
        .join(',');
}

/** The newest `count` release tags of a tag list, oldest first. */
export function newestReleaseTags(tags, count = 2) {
    return tags
        .filter((t) => RELEASE_TAG.test(t))
        .sort(compareRefs)
        .slice(-count);
}

/**
 * The known-broken list of a ref.
 * @param {(commit: string) => boolean} contains whether the ref contains a commit
 * @returns {string[]} the pull request numbers (ascending) and then the finding names
 */
export function knownBroken(contains, fixes = UPSTREAM_FIXES, findings = FINDINGS) {
    const prs = Object.entries(fixes)
        .filter(([, fix]) => !contains(fix.commit))
        .map(([number]) => Number(number))
        .sort((a, b) => a - b)
        .map(String);
    const names = Object.entries(findings)
        .filter(([, f]) => !f.fixedBy || !contains(f.fixedBy))
        .map(([name]) => name);
    return [...prs, ...names];
}
