/**
 * The OpenCCU-Base refs of a run: their order on the report and the derivation of their known-broken lists
 * (scripts/resolve-refs.mjs picks the refs; scripts/report.mjs and scripts/differential.mjs order them).
 */

import {UPSTREAM_FIXES, FINDINGS, FORK_REPO, issueNumber} from '../test/metadata.js';

export const VARIANTS = Object.freeze(['release', 'asan', 'coverage']);
export const RELEASE_TAG = /^\d+(\.\d+)+$/;

/** Where the refs come from: OpenCCU-Base itself, and the fork of FORK_REFS. */
export const UPSTREAM_REPO = 'https://github.com/OpenCCU/OpenCCU-Base.git';

/**
 * openccu-lite's tags on the fork: the image version of each build round, `v1.0.0`, `v1.1.0-dev.5` and the like (the
 * fork also carries upstream's own tags such as 3.89.11, which never count as the fork's).
 */
export const FORK_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

/** openccu-lite's release tags: a FORK_TAG without a pre-release suffix (no `-dev`, `-beta`, `-rc`), e.g. `v1.0.0`. */
export const FORK_RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/**
 * The refs of forks of OpenCCU-Base that every run tests beside upstream's newest release tag and main, each resolved
 * anew on every run:
 *   - `{kind: 'tag', prefix, repo, pattern, branch}`: the fork's newest tag matching `pattern` (by version), labelled
 *     `<prefix><tag>` internally, e.g. `lite@v1.0.0`, and shown under the branch it is cut from (refDisplay). A tag an
 *     earlier entry already resolved to is not tested twice (resolve-refs.mjs);
 *   - `{kind: 'branch', label, repo, ref}`: the head of a branch, labelled `label` (`resolve-refs.mjs --fork`).
 * The differential compares each with the run's upstream release tag.
 *
 * openccu-lite builds its daemons from the fork hobbyquaker/OpenCCU-Base: the branch `lite` is OpenCCU-Base's release
 * plus upstream fixes picked onto it (`git cherry-pick -x`) and fixes that are not upstream yet (pull request
 * candidates, test/metadata.js FINDINGS `fork`); every openccu-lite build round tags the commit it builds with its
 * version. The report shows the newest openccu-lite release (`v1.0.0`: what users run) and the newest tag of all,
 * pre-releases included (`v1.1.0-dev.5`: the build in test) - the latter only while it is newer than the release.
 * @type {ReadonlyArray<{kind: 'tag', prefix: string, repo: string, pattern: RegExp, branch: string}|
 *   {kind: 'branch', label: string, repo: string, ref: string}>}
 */
export const FORK_REFS = Object.freeze([
    Object.freeze({kind: 'tag', prefix: 'lite@', repo: FORK_REPO, pattern: FORK_RELEASE_TAG, branch: 'lite'}),
    Object.freeze({kind: 'tag', prefix: 'lite@', repo: FORK_REPO, pattern: FORK_TAG, branch: 'lite'}),
]);

/** The FORK_REFS entry a report label belongs to, or undefined for an upstream ref. */
export function forkOf(label, forks = FORK_REFS) {
    const l = String(label);
    return forks.find((f) =>
        f.kind === 'tag' ? l.startsWith(f.prefix) && f.pattern.test(l.slice(f.prefix.length)) : f.label === l,
    );
}

/** The tag of a fork tag's label (`lite@v1.0.0-beta.2` -> `v1.0.0-beta.2`), else ''. */
function forkTagOf(label, forks = FORK_REFS) {
    const f = forkOf(label, forks);
    return f && f.kind === 'tag' ? String(label).slice(f.prefix.length) : '';
}

/**
 * Compares two versions `[v]X.Y.Z[-pre]` as semver does: the numbers, then a release after its prereleases, then the
 * prerelease identifiers (numbers numerically, below words; words lexically).
 */
export function compareVersions(a, b) {
    const split = (v) => {
        const [core, ...pre] = String(v).replace(/^v/, '').split('-');
        return {core: core.split('.').map(Number), pre: pre.length ? pre.join('-').split('.') : []};
    };
    const x = split(a);
    const y = split(b);
    for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
        if ((x.core[i] || 0) !== (y.core[i] || 0)) {
            return (x.core[i] || 0) - (y.core[i] || 0);
        }
    }
    if (!x.pre.length || !y.pre.length) {
        return y.pre.length - x.pre.length;
    }
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        const [p, q] = [x.pre[i], y.pre[i]];
        if (p === undefined || q === undefined) {
            return p === undefined ? -1 : 1;
        }
        const [np, nq] = [/^\d+$/.test(p), /^\d+$/.test(q)];
        if (np && nq && Number(p) !== Number(q)) {
            return Number(p) - Number(q);
        }
        if (np !== nq) {
            return np ? -1 : 1;
        }
        if (!np && p !== q) {
            return p < q ? -1 : 1;
        }
    }
    return 0;
}

/** The newest tag of a list that matches `pattern`, by version, or '' when none does. */
export function newestTag(tags, pattern = FORK_TAG) {
    const list = tags.filter((t) => pattern.test(t)).sort(compareVersions);
    return list.length ? list[list.length - 1] : '';
}

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

/**
 * How the report shows a ref (the maintainer's two header rows): grouped by repository and branch -
 * `OpenCCU/OpenCCU-Base/main` above upstream's release tag and main's head, `hobbyquaker/OpenCCU-Base/lite` above the
 * fork's openccu-lite release and pre-release tags (a fork branch from --fork: its head) - and named within the group by
 * the tag (without the `v`) or `head`.
 * @returns {{group: string, groupUrl: string, name: string}} group '' for a ref outside both repositories
 */
export function refDisplay(label, forks = FORK_REFS) {
    const l = String(label);
    const f = forkOf(l, forks);
    const named = (repo, branch) => {
        const web = webUrl(repo);
        return {group: `${web.replace(/^https:\/\/github\.com\//, '')}/${branch}`, groupUrl: `${web}/tree/${branch}`};
    };
    if (f) {
        return f.kind === 'tag'
            ? {...named(f.repo, f.branch), name: l.slice(f.prefix.length).replace(/^v/, '')}
            : {...named(f.repo, f.ref), name: 'head'};
    }
    if (l === 'main' || RELEASE_TAG.test(l)) {
        return {...named(UPSTREAM_REPO, 'main'), name: l === 'main' ? 'head' : l};
    }
    return {group: '', groupUrl: '', name: l};
}

/** Whether a ref is a tag (upstream's release tag or the fork's openccu-lite tag), not a branch head. */
export function isTagRef(label, forks = FORK_REFS) {
    const f = forkOf(label, forks);
    return f ? f.kind === 'tag' : RELEASE_TAG.test(String(label));
}

/**
 * The word for a result on a ref (the maintainer, 2026-10-13): a test whose fix a ref lacks runs as todo; on a tag,
 * which cannot change any more, the report calls it "known", on a head "todo". Only the wording: the data stays todo.
 */
export function statusWord(status, label, forks = FORK_REFS) {
    return status === 'todo' && isTagRef(label, forks) ? 'known' : status;
}

/** A ref as one line of text: "<group> <name>", e.g. "hobbyquaker/OpenCCU-Base/lite 1.0.0-beta.2". */
export function refText(label, forks = FORK_REFS) {
    const d = refDisplay(label, forks);
    return d.group ? `${d.group} ${d.name}` : d.name;
}

/**
 * Two refs as "from → to": within one group "<group>: <from> → <to>" ("OpenCCU/OpenCCU-Base/main: 3.89.11 → head"),
 * across groups both in full.
 */
export function refPairText(from, to, forks = FORK_REFS) {
    const [a, b] = [refDisplay(from, forks), refDisplay(to, forks)];
    return a.group && a.group === b.group
        ? `${a.group}: ${a.name} → ${b.name}`
        : `${refText(from, forks)} → ${refText(to, forks)}`;
}

/** The web address of a repository (`.git` dropped), for commit and pull request links. */
export function webUrl(repo) {
    return String(repo)
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/\.git$/, '');
}

/** The web address of the repository a report column (a ref's label) was built from. */
export function repoOfRef(label, forks = FORK_REFS) {
    const fork = forkOf(label, forks);
    return webUrl(fork ? fork.repo : UPSTREAM_REPO);
}

/** A commit's address, in the repository of the ref that was built from it. */
export function commitUrl(label, sha, forks = FORK_REFS) {
    return `${repoOfRef(label, forks)}/commit/${sha}`;
}

/**
 * Orders refs as the report shows them: upstream's release tags by version, oldest first, then main; then the fork's
 * tags by version and the fork's branches (FORK_REFS); anything else last.
 */
export function compareRefs(a, b, forks = FORK_REFS) {
    const rank = (r) => {
        if (RELEASE_TAG.test(r)) {
            return 0;
        }
        if (r === 'main') {
            return 1;
        }
        const f = forkOf(r, forks);
        return f ? (f.kind === 'tag' ? 2 : 3) : 4;
    };
    if (rank(a) !== rank(b)) {
        return rank(a) - rank(b);
    }
    if (rank(a) === 0) {
        return compareVersions(a, b);
    }
    if (rank(a) === 2) {
        return compareVersions(forkTagOf(a, forks), forkTagOf(b, forks));
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
export function newestReleaseTags(tags, count = 1) {
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
