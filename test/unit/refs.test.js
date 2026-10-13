import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    compareRefs,
    newestReleaseTags,
    knownBroken,
    parseRefSpec,
    webUrl,
    commitUrl,
    repoOfRef,
    forkFixes,
    findingFixes,
    FORK_REFS,
    UPSTREAM_REPO,
} from '../../scripts/refs.mjs';
import {FINDINGS, FORK_REPO} from '../metadata.js';
import {buildDifferential} from '../../scripts/differential.mjs';

test('the refs: release tags by version, oldest first, main last; the two newest tags picked', () => {
    assert.deepEqual(['main', '3.89.11', 'feature-x', '3.89.9', '3.100.0'].sort(compareRefs), [
        '3.89.9',
        '3.89.11',
        '3.100.0',
        'feature-x',
        'main',
    ]);
    // a fork branch sits between the tags and main, next to the tag it starts from
    assert.deepEqual(['main', 'lite-3.89.11', '3.89.11', '3.89.9'].sort(compareRefs), [
        '3.89.9',
        '3.89.11',
        'lite-3.89.11',
        'main',
    ]);
    assert.deepEqual(newestReleaseTags(['3.89.9', 'v-test', '3.89.11', '3.89.10-rc1', '3.88.4', '']), [
        '3.89.9',
        '3.89.11',
    ]);
    assert.deepEqual(newestReleaseTags(['3.89.11']), ['3.89.11']);
});

test('the known-broken list is derived: a fix whose commit the ref lacks, a finding until its fix is in the ref', () => {
    const fixes = {140: {commit: 'c140'}, 27: {commit: 'c27'}, 9: {commit: 'c9'}};
    const findings = {'double-join': {}, 'fixed-later': {fixedBy: 'cf'}};
    const has = (set) => (commit) => set.includes(commit);
    assert.deepEqual(knownBroken(has(['c9']), fixes, findings), ['27', '140', 'double-join', 'fixed-later']);
    assert.deepEqual(knownBroken(has(['c9', 'c27', 'c140', 'cf']), fixes, findings), ['double-join']);
});

test('the differential compares neighbours: the older tag with the newer one, the newer one with main', () => {
    const job = (ref, answer) => ({ref, variant: 'release', baseCommit: `sha-${ref}`, sweep: {s: {m: answer}}});
    const sections = buildDifferential([job('main', 'c'), job('3.89.11', 'b'), job('3.89.9', 'a')]);
    assert.deepEqual(
        sections.map((s) => [s.title, s.diff.changed]),
        [
            ['3.89.9 → 3.89.11', 1],
            ['3.89.11 → main', 1],
        ],
    );
});

test('a ref with its repository: <repo>@<branch>[=<label>], a plain ref is one of OpenCCU-Base', () => {
    assert.deepEqual(parseRefSpec('https://github.com/hobbyquaker/OpenCCU-Base.git@lite-3.89.11'), {
        label: 'lite-3.89.11',
        repo: 'https://github.com/hobbyquaker/OpenCCU-Base.git',
        ref: 'lite-3.89.11',
    });
    assert.deepEqual(parseRefSpec('git@github.com:someone/OpenCCU-Base.git@fix/x=mine'), {
        label: 'mine',
        repo: 'git@github.com:someone/OpenCCU-Base.git',
        ref: 'fix/x',
    });
    assert.deepEqual(parseRefSpec('3.89.11'), {label: '3.89.11', repo: UPSTREAM_REPO, ref: '3.89.11'});
    assert.deepEqual(parseRefSpec('main'), {label: 'main', repo: UPSTREAM_REPO, ref: 'main'});
});

test("the links of a column go to the repository it was built from: a fork branch's to the fork", () => {
    assert.equal(webUrl('git@github.com:a/b.git'), 'https://github.com/a/b');
    assert.equal(repoOfRef('main'), 'https://github.com/OpenCCU/OpenCCU-Base');
    assert.equal(commitUrl('3.89.11', 'abc'), 'https://github.com/OpenCCU/OpenCCU-Base/commit/abc');
    assert.equal(commitUrl('lite-3.89.11', 'abc'), 'https://github.com/hobbyquaker/OpenCCU-Base/commit/abc');
    assert.ok(FORK_REFS.some((f) => f.label === 'lite-3.89.11' && f.repo === FORK_REPO && f.base === '3.89.11'));
});

test('a finding with a fork fix is fixed where the fork commit or, later, the upstream merge commit is', () => {
    const fixes = {140: {commit: 'c140'}};
    const findings = {
        open: {},
        forked: {issue: 'https://github.com/OpenCCU/OpenCCU-Base/issues/164', fork: {commit: 'fk', branch: 'fix/164'}},
        merged: {issue: 'https://github.com/OpenCCU/OpenCCU-Base/issues/165', fork: {commit: 'fm'}, fixedBy: 'um'},
    };
    const has = (set) => (commit) => set.includes(commit);
    // upstream main without any of them; the fork branch with the picks; upstream after merging #165
    assert.deepEqual(knownBroken(has([]), fixes, findings), ['140', 'open', 'forked', 'merged']);
    assert.deepEqual(knownBroken(has(['c140', 'fk', 'fm']), fixes, findings), ['open']);
    assert.deepEqual(knownBroken(has(['c140', 'um']), fixes, findings), ['open', 'forked']);
    assert.deepEqual(findingFixes(findings.merged), ['um', 'fm']);
    // the proof: the fork commit until upstream merges, then the merge commit in OpenCCU-Base
    assert.deepEqual(
        forkFixes(findings).map((f) => [f.issue, f.finding, f.commit, f.repo]),
        [
            [164, 'forked', 'fk', FORK_REPO],
            [165, 'merged', 'um', UPSTREAM_REPO],
        ],
    );
});

test("the fork fixes of the suite's own findings: #164, #165, #170 and #171", () => {
    assert.deepEqual(
        forkFixes(FINDINGS).map((f) => [f.issue, f.finding]),
        [
            [164, 'no-sigterm'],
            [165, 'aes-republish'],
            [170, 'init-blocks'],
            [171, 'async-callback-threads'],
        ],
    );
    for (const f of forkFixes(FINDINGS)) {
        assert.match(f.commit, /^[0-9a-f]{40}$/, `#${f.issue}: a full commit id`);
    }
});

test('the differential compares a fork branch with the tag it starts from, not with its neighbours', () => {
    const job = (ref, answer) => ({ref, variant: 'release', baseCommit: `sha-${ref}`, sweep: {s: {m: answer}}});
    const forks = [{label: 'lite-3.89.11', repo: 'x', ref: 'lite-3.89.11', base: '3.89.11'}];
    const sections = buildDifferential(
        [job('main', 'c'), job('lite-3.89.11', 'd'), job('3.89.11', 'b'), job('3.89.9', 'a')],
        null,
        forks,
    );
    assert.deepEqual(
        sections.map((s) => s.title),
        ['3.89.9 → 3.89.11', '3.89.11 → main', '3.89.11 → lite-3.89.11'],
    );
});
