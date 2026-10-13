/**
 * The OpenCCU-Base refs of a run: their order on the report and the derivation of their known-broken lists
 * (scripts/resolve-refs.mjs picks the refs; scripts/report.mjs and scripts/differential.mjs order them).
 */

import {UPSTREAM_FIXES, FINDINGS, FORK_REPO, issueNumber} from '../test/metadata.js';

export const VARIANTS = Object.freeze(['release', 'asan', 'coverage']);
export const RELEASE_TAG = /^\d+(\.\d+)+$/;

/** Where the refs come from: OpenCCU-Base itself, and the forks of FORK_REFS. */
export const UPSTREAM_REPO = 'https://github.com/OpenCCU/OpenCCU-Base.git';

/**
 * Branches of forks of OpenCCU-Base that every run tests beside the upstream refs, each resolved to its head anew
 * like main. `label` is the column on the report; `base` the upstream tag the branch starts from (the differential
 * compares the branch with it).
 *
 * lite-3.89.11: openccu-lite builds its daemons from this branch - the 3.89.11 tag plus upstream fixes picked onto it
 * (`git cherry-pick -x`) and fixes that are not upstream yet (pull request candidates, test/metadata.js FINDINGS
 * `fork`), so the report shows what that build fixes that upstream does not yet.
 * @type {ReadonlyArray<{label: string, repo: string, ref: string, base: string}>}
 */
export const FORK_REFS = Object.freeze([
    Object.freeze({
        label: 'lite-3.89.11',
        repo: FORK_REPO,
        ref: 'lite-3.89.11',
        base: '3.89.11',
    }),
]);

/**
 * A ref with its repository, `<repo>@<branch>` (split at the last `@`, so `git@host:x.git@branch` works), optionally
 * `=<label>`; a plain ref is a ref of OpenCCU-Base.
 * @returns {{label: string, repo: string, ref: string}}
 */
export function parseRefSpec(spec, upstream = UPSTREAM_REPO) {
    const [body, label] = String(spec).split(/=(?=[^=]*$)/);
    const at = body.lastIndexOf('@');
    if (at <= 0 || !/[:/]/.test(body.slice(0, at))) {
        return {label: label || body, repo: upstream, ref: body};
    }
    const ref = body.slice(at + 1);
    return {label: label || ref, repo: body.slice(0, at), ref};
}

/** The web address of a repository (`.git` dropped), for commit and pull request links. */
export function webUrl(repo) {
    return String(repo)
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/\.git$/, '');
}

/** The web address of the repository a report column (a ref's label) was built from. */
export function repoOfRef(label, forks = FORK_REFS) {
    const fork = forks.find((f) => f.label === label);
    return webUrl(fork ? fork.repo : UPSTREAM_REPO);
}

/** A commit's address, in the repository of the ref that was built from it. */
export function commitUrl(label, sha, forks = FORK_REFS) {
    return `${repoOfRef(label, forks)}/commit/${sha}`;
}

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
 * The commits that fix a finding: its upstream merge commit (`fixedBy`) and its fork commit (`fork.commit`); either one
 * in a ref fixes it there.
 */
export function findingFixes(finding) {
    return [finding.fixedBy, finding.fork && finding.fork.commit].filter(Boolean);
}

/**
 * The fixes that exist on the fork only, or that went upstream later: one per finding with a `fork` commit, keyed by
 * the finding's issue number. The proof (scripts/prove.mjs) runs their tests on the fork commit's parent and the fork
 * commit - or, once upstream merged it (`fixedBy`), on the merge commit's parent and the merge commit.
 * @returns {Array<{issue: number, finding: string, title: string, commit: string, repo: string, proofRepeat?: number}>}
 */
export function forkFixes(findings = FINDINGS) {
    return Object.entries(findings)
        .filter(([, f]) => f.fork && issueNumber(f.issue))
        .map(([name, f]) => ({
            issue: issueNumber(f.issue),
            finding: name,
            title: f.title,
            commit: f.fixedBy || f.fork.commit,
            repo: f.fixedBy ? UPSTREAM_REPO : FORK_REPO,
            ...(f.proofRepeat ? {proofRepeat: f.proofRepeat} : {}),
        }))
        .sort((a, b) => a.issue - b.issue);
}

/**
 * The known-broken list of a ref.
 * @param {(commit: string) => boolean} contains whether the ref contains a commit - as an ancestor, or picked onto it
 *   (scripts/history.mjs)
 * @returns {string[]} the pull request numbers (ascending) and then the finding names
 */
export function knownBroken(contains, fixes = UPSTREAM_FIXES, findings = FINDINGS) {
    const prs = Object.entries(fixes)
        .filter(([, fix]) => !contains(fix.commit))
        .map(([number]) => Number(number))
        .sort((a, b) => a - b)
        .map(String);
    const names = Object.entries(findings)
        .filter(([, f]) => !findingFixes(f).some((commit) => contains(commit)))
        .map(([name]) => name);
    return [...prs, ...names];
}
