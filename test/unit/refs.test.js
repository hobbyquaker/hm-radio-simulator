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
    forkOf,
    refDisplay,
    refText,
    refPairText,
    statusWord,
    isTagRef,
    newestTag,
    compareVersions,
    FORK_TAG,
    FORK_REFS,
    UPSTREAM_REPO,
} from '../../scripts/refs.mjs';
import {FINDINGS, FORK_REPO} from '../metadata.js';
import {buildDifferential} from '../../scripts/differential.mjs';
import {headsOf} from '../../scripts/resolve-refs.mjs';

test('the refs: upstream tags by version, main, the fork tags by version, the fork branch; the newest tag picked', () => {
    assert.deepEqual(['main', '3.89.11', 'feature-x', '3.89.9', '3.100.0'].sort(compareRefs), [
        '3.89.9',
        '3.89.11',
        '3.100.0',
        'main',
        'feature-x',
    ]);
    // upstream first (tag, main), then the fork (tag, branch): the report's 2 x 2
    assert.deepEqual(['lite', 'main', 'lite@v1.0.0-beta.2', '3.89.11'].sort(compareRefs), [
        '3.89.11',
        'main',
        'lite@v1.0.0-beta.2',
        'lite',
    ]);
    assert.deepEqual(['lite@v1.0.0-beta.10', 'lite@v1.0.0', 'lite@v1.0.0-beta.2'].sort(compareRefs), [
        'lite@v1.0.0-beta.2',
        'lite@v1.0.0-beta.10',
        'lite@v1.0.0',
    ]);
    assert.deepEqual(newestReleaseTags(['3.89.9', 'v-test', '3.89.11', '3.89.10-rc1', '3.88.4', '']), ['3.89.11']);
    assert.deepEqual(newestReleaseTags(['3.89.9', '3.89.11', '3.88.4'], 2), ['3.89.9', '3.89.11']);
    assert.deepEqual(newestReleaseTags(['3.89.11']), ['3.89.11']);
});

test("the fork's newest openccu-lite tag: v* by version, upstream's tags in the fork never count", () => {
    const tags = ['3.89.9', '3.89.11', 'v1.0.0-beta.1', 'v1.0.0-beta.2', 'v1.0.0-alpha.7', 'v-test', 'lite'];
    assert.equal(newestTag(tags), 'v1.0.0-beta.2', 'beta after alpha (semver: words lexically)');
    assert.equal(newestTag([...tags, 'v1.0.0-beta.10']), 'v1.0.0-beta.10', 'numbers numerically');
    assert.equal(newestTag([...tags, 'v1.0.0']), 'v1.0.0', 'the release after its prereleases');
    assert.equal(newestTag(['3.89.11']), '');
    assert.ok(FORK_TAG.test('v1.0.0-beta.2') && !FORK_TAG.test('3.89.11') && !FORK_TAG.test('v1.0'));
    assert.equal(compareVersions('v1.0.0-rc.1', 'v1.0.0-beta.9') > 0, true);
    assert.equal(compareVersions('1.0.0-beta', 'v1.0.0-beta.1') < 0, true, 'fewer identifiers sort first');
});

test("the report's names: repository and branch above, the tag without its v or head below", () => {
    assert.deepEqual(refDisplay('3.89.11'), {
        group: 'OpenCCU/OpenCCU-Base/main',
        groupUrl: 'https://github.com/OpenCCU/OpenCCU-Base/tree/main',
        name: '3.89.11',
    });
    assert.equal(refDisplay('main').name, 'head');
    assert.deepEqual(refDisplay('lite@v1.0.0-beta.2'), {
        group: 'hobbyquaker/OpenCCU-Base/lite',
        groupUrl: 'https://github.com/hobbyquaker/OpenCCU-Base/tree/lite',
        name: '1.0.0-beta.2',
    });
    assert.equal(refText('lite'), 'hobbyquaker/OpenCCU-Base/lite head');
    assert.deepEqual(
        refDisplay('lite-3.89.11'),
        {group: '', groupUrl: '', name: 'lite-3.89.11'},
        'an old label as it is',
    );
    assert.equal(refPairText('3.89.11', 'main'), 'OpenCCU/OpenCCU-Base/main: 3.89.11 → head');
    assert.equal(refPairText('lite@v1.0.0-beta.2', 'lite'), 'hobbyquaker/OpenCCU-Base/lite: 1.0.0-beta.2 → head');
});

test('a label belongs to the fork when it is the branch or <prefix><v tag>', () => {
    assert.equal(forkOf('lite').kind, 'branch');
    assert.equal(forkOf('lite@v1.0.0-beta.2').kind, 'tag');
    assert.equal(forkOf('lite@3.89.11'), undefined, "upstream's tag in the fork is not a fork tag");
    assert.equal(forkOf('main'), undefined);
    assert.equal(forkOf('3.89.11'), undefined);
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
            ['OpenCCU/OpenCCU-Base/main: 3.89.9 → 3.89.11', 1],
            ['OpenCCU/OpenCCU-Base/main: 3.89.11 → head', 1],
        ],
    );
});

test('a ref with its repository: <repo>@<branch>[=<label>], a plain ref is one of OpenCCU-Base', () => {
    assert.deepEqual(parseRefSpec('https://github.com/hobbyquaker/OpenCCU-Base.git@lite'), {
        label: 'lite',
        repo: 'https://github.com/hobbyquaker/OpenCCU-Base.git',
        ref: 'lite',
    });
    assert.deepEqual(parseRefSpec('git@github.com:someone/OpenCCU-Base.git@fix/x=mine'), {
        label: 'mine',
        repo: 'git@github.com:someone/OpenCCU-Base.git',
        ref: 'fix/x',
    });
    assert.deepEqual(parseRefSpec('3.89.11'), {label: '3.89.11', repo: UPSTREAM_REPO, ref: '3.89.11'});
    assert.deepEqual(parseRefSpec('main'), {label: 'main', repo: UPSTREAM_REPO, ref: 'main'});
});

test("the links of a column go to the repository it was built from: a fork ref's to the fork", () => {
    assert.equal(webUrl('git@github.com:a/b.git'), 'https://github.com/a/b');
    assert.equal(repoOfRef('main'), 'https://github.com/OpenCCU/OpenCCU-Base');
    assert.equal(commitUrl('3.89.11', 'abc'), 'https://github.com/OpenCCU/OpenCCU-Base/commit/abc');
    assert.equal(commitUrl('lite', 'abc'), 'https://github.com/hobbyquaker/OpenCCU-Base/commit/abc');
    assert.equal(commitUrl('lite@v1.0.0-beta.2', 'abc'), 'https://github.com/hobbyquaker/OpenCCU-Base/commit/abc');
    // the fork's openccu-lite tag and its branch lite
    assert.deepEqual(
        FORK_REFS.map((f) => [f.kind, f.label || f.prefix, f.repo]),
        [
            ['tag', 'lite@', FORK_REPO],
            ['branch', 'lite', FORK_REPO],
        ],
    );
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

test("the differential compares each fork ref with the run's upstream release tag, not with its neighbours", () => {
    const job = (ref, answer) => ({ref, variant: 'release', baseCommit: `sha-${ref}`, sweep: {s: {m: answer}}});
    const sections = buildDifferential([
        job('main', 'c'),
        job('lite', 'd'),
        job('lite@v1.0.0-beta.2', 'e'),
        job('3.89.11', 'b'),
    ]);
    assert.deepEqual(
        sections.map((s) => s.title),
        [
            'OpenCCU/OpenCCU-Base/main: 3.89.11 → head',
            'OpenCCU/OpenCCU-Base/main 3.89.11 → hobbyquaker/OpenCCU-Base/lite 1.0.0-beta.2',
            'OpenCCU/OpenCCU-Base/main 3.89.11 → hobbyquaker/OpenCCU-Base/lite head',
        ],
    );
});

test("the upstream watch's heads from ls-remote: upstream's newest tag and main, the fork's newest v tag and lite", () => {
    const sha = (c) => c.repeat(40);
    const remotes = {
        [UPSTREAM_REPO]: [
            `${sha('1')}\trefs/heads/main`,
            `${sha('2')}\trefs/heads/other`,
            `${sha('3')}\trefs/tags/3.89.9`,
            `${sha('4')}\trefs/tags/3.89.11`,
            `${sha('5')}\trefs/tags/3.89.11^{}`,
        ].join('\n'),
        [FORK_REPO]: [
            `${sha('6')}\trefs/heads/lite`,
            `${sha('7')}\trefs/heads/main`,
            `${sha('8')}\trefs/tags/3.89.12`,
            `${sha('9')}\trefs/tags/v1.0.0-beta.2`,
            `${sha('a')}\trefs/tags/v1.0.0-beta.2^{}`,
            `${sha('b')}\trefs/tags/v1.0.0-beta.1^{}`,
        ].join('\n'),
    };
    assert.deepEqual(headsOf(remotes), [
        `3.89.11 ${sha('5')}`,
        `main ${sha('1')}`,
        `lite@v1.0.0-beta.2 ${sha('a')}`,
        `lite ${sha('6')}`,
    ]);
    // a fork without an openccu-lite tag yet: the branch alone
    assert.deepEqual(headsOf({...remotes, [FORK_REPO]: `${sha('6')}\trefs/heads/lite`}).slice(2), [`lite ${sha('6')}`]);
});

test('a missing fix is "known" on a tag and "todo" on a head; the data stays todo', () => {
    assert.equal(statusWord('todo', '3.89.11'), 'known');
    assert.equal(statusWord('todo', 'lite@v1.0.0-beta.2'), 'known');
    assert.equal(statusWord('todo', 'main'), 'todo');
    assert.equal(statusWord('todo', 'lite'), 'todo');
    assert.equal(statusWord('pass', '3.89.11'), 'pass');
    assert.ok(isTagRef('3.89.11') && isTagRef('lite@v1.0.0-beta.2') && !isTagRef('main') && !isTagRef('lite'));
});
