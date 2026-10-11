#!/usr/bin/env node
/**
 * Which OpenCCU-Base refs a run tests, and what is known broken on each - chosen, not hard-coded: the two newest
 * release tags (`X.Y.Z`, ordered by version) and the head of main. A new upstream tag pushes the oldest one out on
 * the next run.
 *
 * The known-broken list of a ref is derived, not kept by hand: an upstream fix (test/metadata.js UPSTREAM_FIXES, a pull
 * request with its merge commit) is known broken on a ref when its merge commit is not an ancestor of the ref; a
 * finding of this suite (FINDINGS) is known broken everywhere until it gets a `fixedBy` commit, then on every ref that
 * does not contain that commit. The fuzz harnesses expect findings on a ref that lacks #140 (the BIN-RPC length checks:
 * the libFuzzer class the harnesses find within seconds).
 *
 * It needs the upstream history without file contents: a bare, tree-less clone (`--filter=tree:0`).
 *
 * Usage:
 *   node scripts/resolve-refs.mjs [--repo <url>] [--main <sha>] [--tags <n>] [--github-output]
 *     prints {refs, daemons, fuzz} as JSON; with --github-output also writes refs=, daemons=, fuzz= to $GITHUB_OUTPUT
 *     (the matrices of the CI's daemon and fuzz jobs). --main tests that commit as main (the upstream watch).
 *   node scripts/resolve-refs.mjs --known <ref> [--harnesses] [--repo <url>]
 *     prints the known-broken list of one ref, or with --harnesses its FUZZ_KNOWN_HARNESSES (scripts/run-tests.sh)
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {VARIANTS, newestReleaseTags, knownBroken, knownHarnesses} from './refs.mjs';

function git(dir, ...args) {
    return execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

function isAncestor(dir, commit, sha) {
    try {
        execFileSync('git', ['-C', dir, 'merge-base', '--is-ancestor', commit, sha], {stdio: 'ignore'});
        return true;
    } catch {
        return false; // not an ancestor, or a commit the clone does not have
    }
}

export function clone(repo) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openccu-base-'));
    execFileSync('git', ['clone', '--quiet', '--bare', '--filter=tree:0', repo, dir], {stdio: 'inherit'});
    return dir;
}

export function resolve({repo, main = '', tags = 2}) {
    const dir = clone(repo);
    try {
        const picked = newestReleaseTags(git(dir, 'tag', '-l').split('\n'), tags);
        const mainSha = main || git(dir, 'rev-parse', 'refs/heads/main');
        const refs = [
            ...picked.map((t) => ({ref: t, build: t, sha: git(dir, 'rev-parse', `refs/tags/${t}^{commit}`)})),
            {ref: 'main', build: mainSha, sha: mainSha},
        ].map((r) => {
            const known = knownBroken((commit) => isAncestor(dir, commit, r.sha));
            return {
                ...r,
                knownBroken: known.join(','),
                expectFuzzFindings: known.includes('140') ? '1' : '0',
                knownHarnesses: knownHarnesses(known),
            };
        });
        const daemons = refs.flatMap((r) =>
            VARIANTS.map((variant) => ({
                base_ref: r.ref,
                build_ref: r.build,
                variant,
                known_broken: r.knownBroken,
            })),
        );
        const fuzz = refs.map((r) => ({
            base_ref: r.ref,
            build_ref: r.build,
            expect_findings: r.expectFuzzFindings,
            known_harnesses: r.knownHarnesses,
        }));
        return {refs, daemons, fuzz};
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
}

function arg(name, fallback = '') {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const repo = arg('--repo', 'https://github.com/OpenCCU/OpenCCU-Base.git');
    const one = arg('--known');
    if (one) {
        const dir = clone(repo);
        try {
            const sha = git(dir, 'rev-parse', `${one}^{commit}`);
            const known = knownBroken((commit) => isAncestor(dir, commit, sha));
            console.log(process.argv.includes('--harnesses') ? knownHarnesses(known) : known.join(','));
        } finally {
            fs.rmSync(dir, {recursive: true, force: true});
        }
    } else {
        const result = resolve({repo, main: arg('--main'), tags: Number(arg('--tags', '2'))});
        console.log(JSON.stringify(result, null, 2));
        if (process.argv.includes('--github-output') && process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(
                process.env.GITHUB_OUTPUT,
                `refs=${JSON.stringify(result.refs)}\ndaemons=${JSON.stringify(result.daemons)}\nfuzz=${JSON.stringify(result.fuzz)}\n`,
            );
        }
    }
}
