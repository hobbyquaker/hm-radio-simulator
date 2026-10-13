import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {openHistory, pickedCommits, sameCommit} from '../../scripts/history.mjs';
import {knownBroken} from '../../scripts/refs.mjs';

/**
 * A fixture pair of repositories, made with git in a temporary directory:
 *
 *   upstream  base (tag 1.0) - fixA (an upstream fix) - more (main)
 *   fork      main as upstream; fix/x: fixX off main (a fix not upstream yet), fix/y: fixY (not picked anywhere);
 *             lite (off 1.0): fixA picked with -x, fixX picked without -x (only its patch id says so), an own commit
 */
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hmrs-history-'));
    const env = {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: root,
    };
    const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {env, encoding: 'utf8'}).trim();
    const commit = (dir, file, text, message) => {
        fs.writeFileSync(path.join(dir, file), text);
        git(dir, 'add', file);
        git(dir, 'commit', '-qm', message);
        return git(dir, 'rev-parse', 'HEAD');
    };
    const up = path.join(root, 'upstream');
    fs.mkdirSync(up);
    git(up, 'init', '-q', '-b', 'main');
    git(up, 'config', 'uploadpack.allowFilter', 'true');
    commit(up, 'a.c', 'int a;\n', 'base');
    git(up, 'tag', '1.0');
    const fixA = commit(up, 'a.c', 'int a = 1;\n', 'fix a (#1)');
    commit(up, 'b.c', 'int b;\n', 'more');

    const fork = path.join(root, 'fork');
    execFileSync('git', ['clone', '-q', up, fork], {env});
    git(fork, 'config', 'uploadpack.allowFilter', 'true');
    git(fork, 'checkout', '-q', '-b', 'fix/x', 'origin/main');
    const fixX = commit(fork, 'x.c', 'int x = 2;\n', 'fix x');
    git(fork, 'checkout', '-q', '-b', 'fix/y', 'origin/main');
    const fixY = commit(fork, 'y.c', 'int y = 3;\n', 'fix y');
    git(fork, 'checkout', '-q', '-b', 'lite', '1.0');
    git(fork, 'cherry-pick', '-x', fixA);
    git(fork, 'cherry-pick', fixX); // no -x: the message does not say so
    commit(fork, 'own.c', 'int own;\n', 'own');
    git(fork, 'checkout', '-q', 'main');
    return {root, up: `file://${up}`, fork: `file://${fork}`, fixA, fixX, fixY};
}

test('pickedCommits and sameCommit read `cherry picked from` lines and match abbreviated ids', () => {
    assert.deepEqual(
        pickedCommits('fix (#140)\n\n(cherry picked from commit 478d18477b42a35bf4fddaa4a2e8e22b6db6d00a)\n\nother\n'),
        ['478d18477b42a35bf4fddaa4a2e8e22b6db6d00a'],
    );
    assert.ok(sameCommit('478d184', '478d18477b42a35bf4fddaa4a2e8e22b6db6d00a'));
    assert.ok(!sameCommit('478d18', '478d18477b42a35bf4fddaa4a2e8e22b6db6d00a'), 'at least 7 digits');
    assert.ok(!sameCommit('', 'abc'));
});

test('the history: a fix is in a ref as an ancestor, picked with -x, or by its patch id; resolve finds fork branches', () => {
    const f = fixture();
    const history = openHistory({upstream: f.up, forks: [f.fork]});
    try {
        const main = history.resolve(f.up, 'main');
        const tag = history.resolve(f.up, '1.0');
        const lite = history.resolve(f.fork, 'lite');
        assert.match(lite, /^[0-9a-f]{40}$/);
        assert.equal(history.resolve(f.fork, lite.slice(0, 12)), lite, 'a commit id resolves too');
        assert.throws(() => history.resolve(f.fork, 'nope'), /cannot resolve/);
        assert.throws(() => history.resolve('file:///elsewhere', 'main'), /not a repository of this history/);
        assert.deepEqual(history.tags(), ['1.0']);

        assert.equal(history.contains(f.fixA, main), 'ancestor');
        assert.equal(history.contains(f.fixA, tag), false);
        assert.equal(history.contains(f.fixA, lite), 'picked');
        assert.equal(history.contains(f.fixX, lite), 'patch-id');
        assert.equal(history.contains(f.fixX, main), false, 'the fork fix is not upstream');
        assert.equal(history.contains(f.fixY, lite), false, 'a fork fix the branch did not pick');
        assert.equal(history.contains('0123456789abcdef0123456789abcdef01234567', lite), false, 'an unknown commit');
        assert.equal(history.parentOf(f.fixX), main);

        // the known-broken lists the CI derives from it
        const fixes = {1: {commit: f.fixA}};
        const findings = {x: {fork: {commit: f.fixX}}, y: {fork: {commit: f.fixY}}, open: {}};
        const known = (sha) => knownBroken((c) => Boolean(history.contains(c, sha)), fixes, findings);
        assert.deepEqual(known(tag), ['1', 'x', 'y', 'open']);
        assert.deepEqual(known(main), ['x', 'y', 'open']);
        assert.deepEqual(known(lite), ['y', 'open']);
    } finally {
        history.close();
        fs.rmSync(f.root, {recursive: true, force: true});
    }
});
