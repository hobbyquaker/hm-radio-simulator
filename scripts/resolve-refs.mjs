#!/usr/bin/env node
/**
 * Which OpenCCU-Base refs a run tests, and what is known broken on each - chosen, not hard-coded: upstream's newest
 * release tag (`X.Y.Z`, by version) and the head of main, and the refs of FORK_REFS (scripts/refs.mjs): on the fork
 * hobbyquaker/OpenCCU-Base the newest openccu-lite release tag (`vX.Y.Z`, no pre-release suffix) and the newest tag
 * including pre-releases (`v1.1.0-dev.5`), the latter only while it is newer than the release. A new tag on either side
 * replaces the previous one on the next run.
 *
 * The known-broken list of a ref is derived, not kept by hand: an upstream fix (test/metadata.js UPSTREAM_FIXES, a pull
 * request with its merge commit) is known broken on a ref that does not contain its commit; a finding of this suite
 * (FINDINGS) is known broken on every ref that contains none of its fixes (`fixedBy` upstream, `fork.commit` on the
 * fork). "Contains" is an ancestor, a pick with `cherry picked from commit <sha>`, or a commit with the same patch id
 * (scripts/history.mjs). The fuzz harnesses expect findings on a ref that lacks #140 (the BIN-RPC length checks: the
 * libFuzzer class the harnesses find within seconds).
 *
 * Usage:
 *   node scripts/resolve-refs.mjs [--repo <url>] [--main <sha>] [--tags <n>] [--fork <repo>@<branch>[=<label>]]...
 *                                 [--no-forks] [--github-output]
 *     prints {refs, daemons, fuzz, tsan} as JSON; with --github-output also writes refs=, daemons=, fuzz=, tsan= to
 *     $GITHUB_OUTPUT (tsan: main and the newest fork tag, for the ThreadSanitizer job)
 *     (the matrices of the CI's daemon and fuzz jobs). --main tests that commit as main (the upstream watch); --tags
 *     the number of upstream release tags (default 1); --fork replaces FORK_REFS by fork branches (heads: tsan runs
 *     on them too), --no-forks leaves them out.
 *   node scripts/resolve-refs.mjs --heads [--repo <url>]
 *     prints "<label> <commit>" per ref a run would test, from `git ls-remote` alone (no clone): the upstream watch
 *     compares them with the last tested ones
 *   node scripts/resolve-refs.mjs --known <ref> [--harnesses] [--repo <url>]
 *     prints the known-broken list of one ref of --repo (OpenCCU-Base or a fork), or with --harnesses its
 *     FUZZ_KNOWN_HARNESSES (scripts/run-tests.sh)
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';

import {
    VARIANTS,
    FORK_REFS,
    compareRefs,
    forkOf,
    UPSTREAM_REPO,
    newestReleaseTags,
    newestTag,
    knownBroken,
    knownHarnesses,
    parseRefSpec,
} from './refs.mjs';
import {openHistory} from './history.mjs';
import {FORK_REPO} from '../test/metadata.js';

/** The known-broken facts of one ref. */
function judged(history, sha) {
    const known = knownBroken((commit) => Boolean(history.contains(commit, sha)));
    return {
        knownBroken: known.join(','),
        expectFuzzFindings: known.includes('140') ? '1' : '0',
        knownHarnesses: knownHarnesses(known),
    };
}

/**
 * The refs of FORK_REFS (or of `forks`) resolved in a history: a tag entry to the fork's newest matching tag (left out
 * when the fork has none, or when an earlier entry already resolved to the same tag: the newest pre-release tag only
 * while it is newer than the newest release tag), a branch entry to its head.
 * @returns {Array<{ref: string, repo: string, build: string, sha: string, head?: boolean}>} `head` marks a branch
 */
export function resolveForks(history, forks = FORK_REFS) {
    const taken = new Set();
    return forks.flatMap((f) => {
        if (f.kind === 'tag') {
            const tag = newestTag(history.forkTags(f.repo), f.pattern);
            if (!tag) {
                console.error(`no tag matching ${f.pattern} in ${f.repo}: left out`);
                return [];
            }
            const ref = `${f.prefix}${tag}`;
            if (taken.has(ref)) {
                console.error(`${ref} is tested already (no newer tag matching ${f.pattern}): left out`);
                return [];
            }
            taken.add(ref);
            const sha = history.resolve(f.repo, tag);
            return [{ref, repo: f.repo, build: sha, sha}];
        }
        // a fork branch is built at the commit resolved here, so the image and its known-broken list agree
        const sha = history.resolve(f.repo, f.ref);
        return [{ref: f.label, repo: f.repo, build: sha, sha, head: true}];
    });
}

/**
 * The refs the ThreadSanitizer job runs on: the heads (main, a fork branch) and the newest fork tag - a race fix
 * lands there first, and the older tags cannot change any more.
 * @param {Array<{ref: string, head?: boolean}>} refs
 */
export function tsanRefs(refs, forks = FORK_REFS) {
    const tags = refs.filter((r) => !r.head && forkOf(r.ref, forks)).sort((a, b) => compareRefs(a.ref, b.ref, forks));
    const newest = tags[tags.length - 1];
    return refs.filter((r) => r.head || r === newest);
}

/**
 * @param {{repo?: string, main?: string, tags?: number, forks?: typeof FORK_REFS}} o
 */
export function resolve({repo = UPSTREAM_REPO, main = '', tags = 1, forks = FORK_REFS}) {
    const history = openHistory({upstream: repo, forks: [FORK_REPO, ...forks.map((f) => f.repo)]});
    try {
        const picked = newestReleaseTags(history.tags(), tags);
        const mainSha = main || history.resolve(repo, 'main');
        const refs = [
            ...picked.map((t) => ({ref: t, repo, build: t, sha: history.resolve(repo, t)})),
            {ref: 'main', repo, build: mainSha, sha: mainSha, head: true},
            ...resolveForks(history, forks),
        ].map((r) => ({...r, ...judged(history, r.sha)}));
        const daemons = refs.flatMap((r) =>
            VARIANTS.map((variant) => ({
                base_ref: r.ref,
                base_repo: r.repo,
                build_ref: r.build,
                variant,
                known_broken: r.knownBroken,
            })),
        );
        const tsan = tsanRefs(refs, forks).map((r) => ({
            base_ref: r.ref,
            base_repo: r.repo,
            build_ref: r.build,
            variant: 'tsan',
            known_broken: r.knownBroken,
        }));
        const fuzz = refs.map((r) => ({
            base_ref: r.ref,
            base_repo: r.repo,
            build_ref: r.build,
            expect_findings: r.expectFuzzFindings,
            known_harnesses: r.knownHarnesses,
        }));
        return {refs, daemons, fuzz, tsan};
    } finally {
        history.close();
    }
}

/**
 * The refs of a run from `git ls-remote` output: "<sha>\t<ref>" lines per repository (tags peeled with `^{}`).
 * @param {Record<string, string>} remotes the ls-remote output per repository
 * @returns {string[]} "<label> <commit>" lines in the report's order
 */
export function headsOf(remotes, {repo = UPSTREAM_REPO, tags = 1, forks = FORK_REFS} = {}) {
    const parse = (text) => {
        const refs = new Map();
        for (const line of String(text || '').split('\n')) {
            const [sha, name] = line.split('\t');
            if (sha && name) {
                // a peeled tag (`^{}`, the commit of an annotated tag) wins over the tag object
                const key = name.replace(/\^\{\}$/, '');
                if (name.endsWith('^{}') || !refs.has(key)) {
                    refs.set(key, sha);
                }
            }
        }
        return refs;
    };
    const tagsOf = (refs) => [...refs.keys()].filter((k) => k.startsWith('refs/tags/')).map((k) => k.slice(10));
    const up = parse(remotes[repo]);
    const lines = newestReleaseTags(tagsOf(up), tags).map((t) => `${t} ${up.get(`refs/tags/${t}`)}`);
    lines.push(`main ${up.get('refs/heads/main')}`);
    for (const f of forks) {
        const refs = parse(remotes[f.repo]);
        if (f.kind === 'tag') {
            const tag = newestTag(tagsOf(refs), f.pattern);
            const line = tag && `${f.prefix}${tag} ${refs.get(`refs/tags/${tag}`)}`;
            if (line && !lines.includes(line)) {
                lines.push(line);
            }
        } else if (refs.has(`refs/heads/${f.ref}`)) {
            lines.push(`${f.label} ${refs.get(`refs/heads/${f.ref}`)}`);
        }
    }
    return lines;
}

function arg(name, fallback = '') {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

function args(name) {
    return process.argv.flatMap((a, i) => (a === name && i + 1 < process.argv.length ? [process.argv[i + 1]] : []));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const one = arg('--known');
    if (one) {
        const repo = arg('--repo', UPSTREAM_REPO);
        const history = openHistory({forks: [FORK_REPO, repo]});
        try {
            const sha = history.resolve(repo, one);
            const {knownBroken: list, knownHarnesses: harnesses} = judged(history, sha);
            console.log(process.argv.includes('--harnesses') ? harnesses : list);
        } finally {
            history.close();
        }
    } else if (process.argv.includes('--heads')) {
        const repo = arg('--repo', UPSTREAM_REPO);
        const remotes = {};
        for (const r of new Set([repo, ...FORK_REFS.map((f) => f.repo)])) {
            remotes[r] = execFileSync('git', ['ls-remote', '--heads', '--tags', r], {encoding: 'utf8'});
        }
        console.log(headsOf(remotes, {repo, tags: Number(arg('--tags', '1'))}).join('\n'));
    } else {
        const forks = process.argv.includes('--no-forks')
            ? []
            : args('--fork').length
              ? args('--fork').map((spec) => ({kind: 'branch', ...parseRefSpec(spec)}))
              : FORK_REFS;
        const result = resolve({
            repo: arg('--repo', UPSTREAM_REPO),
            main: arg('--main'),
            tags: Number(arg('--tags', '1')),
            forks,
        });
        console.log(JSON.stringify(result, null, 2));
        if (process.argv.includes('--github-output') && process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(
                process.env.GITHUB_OUTPUT,
                `refs=${JSON.stringify(result.refs)}\ndaemons=${JSON.stringify(result.daemons)}\nfuzz=${JSON.stringify(result.fuzz)}\ntsan=${JSON.stringify(result.tsan)}\n`,
            );
        }
    }
}
