/**
 * The OpenCCU-Base history the refs are resolved in and their known-broken lists derived from: a bare, tree-less clone
 * of OpenCCU-Base (`--filter=tree:0`: the commits without file contents) plus the branches of the forks
 * (scripts/refs.mjs FORK_REFS, test/metadata.js FORK_REPO) under `refs/forks/<n>/` and their tags under
 * `refs/fork-tags/<n>/`, fetched into the same object store (never as upstream's own branches and tags).
 *
 * Whether a ref contains a fix (contains below) is answered in three steps:
 *   1. the fix's commit is an ancestor of the ref (upstream merged it before the ref);
 *   2. a commit of the ref says `(cherry picked from commit <the fix's commit>)` - a fork branch that picked it with
 *      `git cherry-pick -x`;
 *   3. a commit of the ref that upstream does not have (`<ref> --not` upstream's branches and tags) has the fix's patch
 *      id (`git patch-id --stable`) - a pick without `-x`. Only this step needs file contents; the clone fetches them
 *      on demand for those few commits, and upstream's own refs never get here (that range is empty for them).
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {UPSTREAM_REPO} from './refs.mjs';
import {FORK_REPO} from '../test/metadata.js';

const PICKED = /\(cherry picked from commit ([0-9a-f]{7,40})\)/g;

/** The commits a body of commit messages names as picked (`git cherry-pick -x`). */
export function pickedCommits(messages) {
    return [...String(messages).matchAll(PICKED)].map((m) => m[1]);
}

/** Whether two commit ids name the same commit: the shorter one is a prefix of the longer one (at least 7 digits). */
export function sameCommit(a, b) {
    if (!a || !b) {
        return false;
    }
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.length >= 7 && long.startsWith(short);
}

function sameRepo(a, b) {
    const norm = (u) =>
        String(u)
            .replace(/\.git$/, '')
            .replace(/\/$/, '')
            .toLowerCase();
    return norm(a) === norm(b);
}

/**
 * Opens a history in a git directory: `git` runs git there; contains, resolve and parentOf answer from it.
 * Exposed apart from openHistory so the unit tests can run it on a local fixture repository.
 * @param {string} dir a (bare) repository with upstream's branches and tags as its own, the forks' branches under
 *   refs/forks/<n>/ and their tags under refs/fork-tags/<n>/
 * @param {{upstream?: string, forks?: string[]}} o the repositories, in the order of refs/forks/<n>
 */
export function historyAt(dir, {upstream = UPSTREAM_REPO, forks = []} = {}) {
    const git = (args, input) =>
        execFileSync('git', ['-C', dir, ...args], {
            encoding: 'utf8',
            input,
            stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
            maxBuffer: 256 * 1024 * 1024,
        }).trim();
    const ok = (args) => {
        try {
            git(args);
            return true;
        } catch {
            return false;
        }
    };
    const picked = new Map();
    const forkPatchIds = new Map();
    const patchIds = new Map();

    const known = (commit) => ok(['cat-file', '-e', `${commit}^{commit}`]);

    function patchId(commit) {
        if (!patchIds.has(commit)) {
            let id = null;
            try {
                const diff = git(['diff-tree', '-p', '--no-commit-id', '--no-color', commit]);
                id = diff ? git(['patch-id', '--stable'], diff + '\n').split(' ')[0] || null : null;
            } catch {
                id = null; // a commit the clone cannot read
            }
            patchIds.set(commit, id);
        }
        return patchIds.get(commit);
    }

    /** The commits picked onto the ref (named by `cherry picked from` lines anywhere in its history). */
    function pickedOnto(sha) {
        if (!picked.has(sha)) {
            picked.set(sha, pickedCommits(git(['log', '--format=%B', sha])));
        }
        return picked.get(sha);
    }

    /** The patch ids of the ref's commits that upstream has not (empty for upstream's own refs). */
    function forkOnlyPatchIds(sha) {
        if (!forkPatchIds.has(sha)) {
            const range = git(['rev-list', '--no-merges', sha, '--not', '--branches', '--tags'])
                .split('\n')
                .filter(Boolean);
            forkPatchIds.set(sha, new Set(range.map(patchId).filter(Boolean)));
        }
        return forkPatchIds.get(sha);
    }

    /**
     * Whether the ref at `sha` contains `commit`: as an ancestor, picked with -x, or a commit with its patch id.
     * @returns {false|'ancestor'|'picked'|'patch-id'}
     */
    function contains(commit, sha) {
        if (ok(['merge-base', '--is-ancestor', commit, sha])) {
            return 'ancestor';
        }
        if (pickedOnto(sha).some((c) => sameCommit(c, commit))) {
            return 'picked';
        }
        if (!known(commit)) {
            return false;
        }
        const id = forkOnlyPatchIds(sha).size ? patchId(commit) : null;
        return id && forkOnlyPatchIds(sha).has(id) ? 'patch-id' : false;
    }

    /** A ref of a repository to its commit: a branch, a tag or a commit id. */
    function resolve(repo, ref) {
        const candidates = [];
        if (!repo || sameRepo(repo, upstream)) {
            candidates.push(`refs/heads/${ref}`, `refs/tags/${ref}^{commit}`);
        } else {
            const n = forks.findIndex((f) => sameRepo(f, repo));
            if (n < 0) {
                throw new Error(`${repo} is not a repository of this history`);
            }
            candidates.push(`refs/forks/${n}/${ref}`, `refs/fork-tags/${n}/${ref}^{commit}`);
        }
        candidates.push(`${ref}^{commit}`);
        for (const c of candidates) {
            try {
                return git(['rev-parse', '--verify', '--quiet', c]);
            } catch {
                // the next form
            }
        }
        throw new Error(`cannot resolve ${ref} in ${repo || upstream}`);
    }

    return {
        dir,
        git,
        contains,
        resolve,
        parentOf: (sha) => git(['rev-parse', `${sha}^1`]),
        tags: () => git(['tag', '-l']).split('\n').filter(Boolean),
        /** The tags of a fork (its copies of upstream's tags included). */
        forkTags(repo) {
            const n = forks.findIndex((f) => sameRepo(f, repo));
            if (n < 0) {
                throw new Error(`${repo} is not a repository of this history`);
            }
            return git(['for-each-ref', '--format=%(refname:strip=3)', `refs/fork-tags/${n}/`])
                .split('\n')
                .filter(Boolean);
        },
    };
}

/**
 * Clones OpenCCU-Base (tree-less) and fetches the forks' branches into it.
 * @param {{upstream?: string, forks?: string[]}} o the forks default to FORK_REPO; duplicates are fetched once
 * @returns {ReturnType<typeof historyAt> & {close: () => void}}
 */
export function openHistory({upstream = UPSTREAM_REPO, forks = [FORK_REPO]} = {}) {
    const list = forks.filter((f, i) => !sameRepo(f, upstream) && forks.findIndex((g) => sameRepo(g, f)) === i);
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || os.tmpdir()), 'openccu-base-'));
    const run = (args) => execFileSync('git', args, {stdio: ['ignore', 'ignore', 'inherit']});
    try {
        run(['clone', '--quiet', '--bare', '--filter=tree:0', upstream, dir]);
        list.forEach((repo, n) => {
            const remote = `fork${n}`;
            run(['-C', dir, 'remote', 'add', remote, repo]);
            // a promisor too: the patch ids need the contents of fork commits, which only the fork can hand out
            run(['-C', dir, 'config', `remote.${remote}.promisor`, 'true']);
            run(['-C', dir, 'config', `remote.${remote}.partialclonefilter`, 'tree:0']);
            run([
                '-C',
                dir,
                'fetch',
                '--quiet',
                '--no-tags',
                '--filter=tree:0',
                remote,
                `+refs/heads/*:refs/forks/${n}/*`,
                `+refs/tags/*:refs/fork-tags/${n}/*`,
            ]);
        });
    } catch (err) {
        fs.rmSync(dir, {recursive: true, force: true});
        throw err;
    }
    const history = historyAt(dir, {upstream, forks: list});
    return {...history, close: () => fs.rmSync(dir, {recursive: true, force: true})};
}
