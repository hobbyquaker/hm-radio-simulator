#!/usr/bin/env node
/**
 * Which OpenCCU-Base refs a run tests, and what is known broken on each - chosen, not hard-coded: the two newest
 * release tags (`X.Y.Z`, ordered by version), the head of main, and the head of each fork branch of FORK_REFS
 * (scripts/refs.mjs: openccu-lite's lite-3.89.11 of hobbyquaker/OpenCCU-Base). A new upstream tag pushes the oldest one
 * out on the next run.
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
 *     prints {refs, daemons, fuzz} as JSON; with --github-output also writes refs=, daemons=, fuzz= to $GITHUB_OUTPUT
 *     (the matrices of the CI's daemon and fuzz jobs). --main tests that commit as main (the upstream watch); --fork
 *     replaces FORK_REFS, --no-forks leaves them out.
 *   node scripts/resolve-refs.mjs --known <ref> [--harnesses] [--repo <url>]
 *     prints the known-broken list of one ref of --repo (OpenCCU-Base or a fork), or with --harnesses its
 *     FUZZ_KNOWN_HARNESSES (scripts/run-tests.sh)
 */

import fs from 'node:fs';

import {
    VARIANTS,
    FORK_REFS,
    UPSTREAM_REPO,
    newestReleaseTags,
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
 * @param {{repo?: string, main?: string, tags?: number, forks?: Array<{label: string, repo: string, ref: string}>}} o
 */
export function resolve({repo = UPSTREAM_REPO, main = '', tags = 2, forks = FORK_REFS}) {
    const history = openHistory({upstream: repo, forks: [FORK_REPO, ...forks.map((f) => f.repo)]});
    try {
        const picked = newestReleaseTags(history.tags(), tags);
        const mainSha = main || history.resolve(repo, 'main');
        const refs = [
            ...picked.map((t) => ({ref: t, repo, build: t, sha: history.resolve(repo, t)})),
            {ref: 'main', repo, build: mainSha, sha: mainSha},
            // a fork branch is built at the commit resolved here, so the image and its known-broken list agree
            ...forks.map((f) => {
                const sha = history.resolve(f.repo, f.ref);
                return {ref: f.label, repo: f.repo, build: sha, sha};
            }),
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
        const fuzz = refs.map((r) => ({
            base_ref: r.ref,
            base_repo: r.repo,
            build_ref: r.build,
            expect_findings: r.expectFuzzFindings,
            known_harnesses: r.knownHarnesses,
        }));
        return {refs, daemons, fuzz};
    } finally {
        history.close();
    }
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
    } else {
        const forks = process.argv.includes('--no-forks')
            ? []
            : args('--fork').length
              ? args('--fork').map((spec) => parseRefSpec(spec))
              : FORK_REFS;
        const result = resolve({
            repo: arg('--repo', UPSTREAM_REPO),
            main: arg('--main'),
            tags: Number(arg('--tags', '2')),
            forks,
        });
        console.log(JSON.stringify(result, null, 2));
        if (process.argv.includes('--github-output') && process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(
                process.env.GITHUB_OUTPUT,
                `refs=${JSON.stringify(result.refs)}\ndaemons=${JSON.stringify(result.daemons)}\nfuzz=${JSON.stringify(result.fuzz)}\n`,
            );
        }
    }
}
