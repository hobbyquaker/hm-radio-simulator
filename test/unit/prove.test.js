import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {UPSTREAM_FIXES, FORK_REPO} from '../metadata.js';
import {forkFixes, UPSTREAM_REPO} from '../../scripts/refs.mjs';
import {
    proofFixes,
    planJobs,
    proofRelevant,
    proofPattern,
    proofTests,
    judgeFix,
    collectProof,
    proofForTest,
} from '../../scripts/prove.mjs';

const DAEMON_TESTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'daemon');

test('every upstream fix has a daemon test that carries its number and uses regression(<number>)', () => {
    const sources = fs
        .readdirSync(DAEMON_TESTS)
        .filter((f) => f.endsWith('.test.js'))
        .map((f) => fs.readFileSync(path.join(DAEMON_TESTS, f), 'utf8'))
        .join('\n');
    for (const fix of Object.keys(UPSTREAM_FIXES)) {
        assert.match(sources, new RegExp(proofPattern(fix)), `a test name with #${fix}`);
        assert.match(
            sources,
            new RegExp(`regression\\(([^)]*[ ,])?${fix}(?!\\d)`),
            `a test with regression(${fix}): without it the test fails instead of todo on refs without the fix`,
        );
    }
    // a fix on the fork: the issue number in a test's name, regression(<the finding>) on the test
    for (const fix of forkFixes()) {
        assert.match(sources, new RegExp(proofPattern(fix.issue)), `a test name with #${fix.issue}`);
        assert.match(
            sources,
            new RegExp(`regression\\(([^)]*[ ,])?'${fix.finding}'`),
            `a test with regression('${fix.finding}') for #${fix.issue}`,
        );
    }
});

test('the proof covers the upstream fixes and the fork fixes, each with the repository its commits are in', () => {
    const all = proofFixes();
    for (const number of Object.keys(UPSTREAM_FIXES)) {
        assert.equal(all[number].repo, UPSTREAM_REPO);
    }
    for (const issue of [164, 165, 170, 171]) {
        assert.equal(all[issue].repo, FORK_REPO, `#${issue} from the fork`);
        assert.ok(all[issue].finding);
    }
    // a fork fix's pair is the fork commit's parent and the fork commit, both fetched from the fork
    const findings = {f: {title: 't', issue: 'https://x/issues/200', fork: {commit: 'fk'}}};
    const fixes = proofFixes({}, findings);
    const jobs = planJobs({parentOf: (sha) => `${sha}^`, contains: (commit, sha) => commit === sha, findings}, fixes);
    assert.deepEqual(
        jobs.map((j) => [j.fix, j.side, j.sha, j.repo, j.known_broken, j.pattern]),
        [
            [200, 'parent', 'fk^', FORK_REPO, 'f', '#200(?!\\d)'],
            [200, 'merge', 'fk', FORK_REPO, '', '#200(?!\\d)'],
        ],
    );
});

test('the name pattern selects #9 but not #90', () => {
    const re = new RegExp(proofPattern(9));
    assert.ok(re.test('restart: a type byte >= 0x80 survives (#9 shape)'));
    assert.ok(!re.test('#90: something else'));
});

test('the plan: one job per fix and side, the parent with the fix in its known-broken list and the repeats', () => {
    const fixes = {16: {title: 'a', commit: 'm16', proofRepeat: 5}, 17: {title: 'b', commit: 'm17'}};
    // history: p16 -> m16 -> m17 (#17's parent is #16's merge commit)
    const order = ['p16', 'm16', 'm17'];
    const contains = (commit, sha) => order.indexOf(commit) >= 0 && order.indexOf(commit) <= order.indexOf(sha);
    const jobs = planJobs({parentOf: (sha) => order[order.indexOf(sha) - 1], contains}, fixes);
    assert.deepEqual(
        jobs.map((j) => [
            j.fix,
            j.side,
            j.sha,
            j.known_broken
                .split(',')
                .filter((x) => /^\d+$/.test(x))
                .join(','),
            j.repeat,
        ]),
        [
            [16, 'parent', 'p16', '16,17', 5],
            [16, 'merge', 'm16', '17', 1],
            [17, 'parent', 'm16', '17', 1],
            [17, 'merge', 'm17', '', 1],
        ],
    );
    assert.throws(() => planJobs({fixes: [99], parentOf: () => '', contains: () => true}, fixes), /#99/);
});

test('proofTests: a todo keeps its outcome, skips are left out, old tests.json fall back to the status', () => {
    const tests = proofTests({
        tests: [
            {file: 'f', nesting: 0, name: 'a', status: 'todo', outcome: 'fail', error: 'boom'},
            {file: 'f', nesting: 0, name: 'b', status: 'skip', outcome: 'pass'},
            {file: 'f', nesting: 0, name: 'c', status: 'fail'},
            {file: 'f', nesting: 0, name: 'd', status: 'todo'},
            {file: 'test/daemon/x.test.js', nesting: 0, name: 'test/daemon/x.test.js', status: 'pass'},
        ],
    });
    assert.deepEqual(
        tests.map((t) => [t.name, t.outcome, t.error]),
        [
            ['a', 'fail', 'boom'],
            ['c', 'fail', undefined],
            ['d', 'pass', undefined],
        ],
    );
});

const t = (name, outcome, nesting = 0) => ({file: 'test/daemon/x.test.js', nesting, name, outcome});
const run = (side, variants, build = 'ok') => ({
    fix: 9,
    side,
    sha: `${side}-sha`,
    date: '2026-10-11T12:00:00Z',
    build,
    variants,
});
const fixes = {9: {title: 'nine', commit: 'merge-sha'}};

test('judgeFix: proven, not proven, inconclusive, no build, incomplete', () => {
    const proven = judgeFix(
        9,
        run('parent', {
            release: {runs: 1, tests: [t('a', 'fail'), t('b', 'pass')]},
            asan: {runs: 1, tests: [t('a', 'pass')]},
        }),
        run('merge', {release: {runs: 1, tests: [t('a', 'pass'), t('b', 'pass')]}}),
        fixes,
    );
    assert.equal(proven.status, 'proven');
    assert.deepEqual(proven.failedOnParent, ['a']);
    assert.equal(proven.passedOnMerge, true);
    assert.deepEqual(
        proven.tests.map((x) => [x.name, x.parent, x.merge, x.proves]),
        [
            ['a', 'fail', 'pass', true],
            ['b', 'pass', 'pass', false],
        ],
    );

    const notProven = judgeFix(
        9,
        run('parent', {asan: {runs: 5, tests: [t('a', 'pass')]}}),
        run('merge', {asan: {runs: 1, tests: [t('a', 'pass')]}}),
        fixes,
    );
    assert.equal(notProven.status, 'not-proven');
    assert.deepEqual(notProven.parentRuns, {asan: 5});

    const inconclusive = judgeFix(
        9,
        run('parent', {release: {runs: 1, tests: [t('a', 'fail')]}}),
        run('merge', {release: {runs: 1, tests: [t('a', 'fail')]}}),
        fixes,
    );
    assert.equal(inconclusive.status, 'inconclusive');
    assert.equal(inconclusive.passedOnMerge, false);

    const noBuild = judgeFix(9, run('parent', {}, 'failed'), run('merge', {release: {runs: 1, tests: []}}), fixes);
    assert.equal(noBuild.status, 'no-build');
    assert.deepEqual(noBuild.noBuild, ['parent']);

    assert.equal(
        judgeFix(9, run('parent', {release: {runs: 1, tests: []}}), run('merge', {}), fixes).status,
        'no-tests',
    );
    const incomplete = judgeFix(9, run('parent', {release: {runs: 1, tests: [t('a', 'fail')]}}), undefined, fixes);
    assert.equal(incomplete.status, 'incomplete');
    assert.deepEqual(incomplete.missing, ['merge']);
});

test('collectProof keeps the previous entries of fixes without runs and drops fixes no longer listed', () => {
    const previous = {fixes: {9: {fix: 9, status: 'old'}, 13: {fix: 13, status: 'proven'}, 112: {fix: 112}}};
    const all = {9: fixes[9], 13: {title: 'x', commit: 'c13'}};
    const proof = collectProof(
        [
            run('parent', {release: {runs: 1, tests: [t('a', 'fail')]}}),
            run('merge', {release: {runs: 1, tests: [t('a', 'pass')]}}),
        ],
        previous,
        all,
    );
    assert.deepEqual(Object.keys(proof.fixes), ['9', '13']);
    assert.equal(proof.fixes[9].status, 'proven');
    assert.equal(proof.fixes[13].status, 'proven');
});

test('proofForTest: the proof field of a report test', () => {
    const proof = collectProof(
        [
            run('parent', {release: {runs: 1, tests: [t('a', 'fail'), t('b', 'pass', 1)]}}),
            run('merge', {release: {runs: 1, tests: [t('a', 'pass'), t('b', 'pass', 1)]}}),
        ],
        null,
        fixes,
    );
    const refs = [{kind: 'pr', label: 'OpenCCU-Base #9'}];
    assert.deepEqual(proofForTest({...t('a'), refs}, proof), {
        status: 'proven',
        fix: 9,
        parent: 'parent-sha',
        merge: 'merge-sha',
        date: '2026-10-11T12:00:00Z',
    });
    assert.equal(proofForTest({...t('b', undefined, 1), refs}, proof).status, 'not-proven');
    assert.equal(proofForTest({...t('c'), refs}, proof), null);
    assert.equal(proofForTest({...t('a'), refs: []}, proof), null);
    assert.equal(proofForTest({...t('a'), refs}, null), null);

    // a fork fix: the test refers to the finding's issue; the proof's entry names the fork
    const forkFix = {200: {title: 'f', commit: 'merge-sha', repo: FORK_REPO, finding: 'f'}};
    const forkProof = collectProof(
        [
            {...run('parent', {release: {runs: 1, tests: [t('a', 'fail')]}}), fix: 200},
            {...run('merge', {release: {runs: 1, tests: [t('a', 'pass')]}}), fix: 200},
        ],
        null,
        forkFix,
    );
    assert.equal(forkProof.fixes[200].repo, 'https://github.com/hobbyquaker/OpenCCU-Base');
    const issueRefs = [{kind: 'issue', label: 'f (issue)', url: 'https://github.com/OpenCCU/OpenCCU-Base/issues/200'}];
    assert.deepEqual(proofForTest({...t('a'), refs: issueRefs}, forkProof), {
        status: 'proven',
        fix: 200,
        parent: 'parent-sha',
        merge: 'merge-sha',
        date: '2026-10-11T12:00:00Z',
        repo: 'https://github.com/hobbyquaker/OpenCCU-Base',
        finding: 'f',
    });
});

test('proofRelevant: the fix list, the proof machinery, or a changed line with a fix number or regression(<n>)', () => {
    assert.match(proofRelevant(['README.md', 'test/metadata.js'], ''), /metadata/);
    assert.equal(proofRelevant(['README.md', 'lib/air.js'], ''), null);
    const diff = (line) =>
        `diff --git a/x b/x\n--- a/test/daemon/x.test.js\n+++ b/test/daemon/x.test.js\n@@ -1 +1 @@\n${line}`;
    assert.match(proofRelevant(['test/daemon/x.test.js'], diff('+    options(regression(13)),')), /regression/);
    assert.match(proofRelevant(['test/daemon/x.test.js'], diff("-test('#27: a receiver', async () => {")), /#27/);
    assert.equal(proofRelevant(['test/daemon/x.test.js'], diff('+    await sleep(100);')), null);
});

test('buildReport carries the proof and puts a proof field on the tests the proof ran', async () => {
    const {buildReport} = await import('../../scripts/report.mjs');
    const proof = collectProof(
        [
            run('parent', {release: {runs: 1, tests: [t('a', 'fail')]}}),
            run('merge', {release: {runs: 1, tests: [t('a', 'pass')]}}),
        ],
        null,
        fixes,
    );
    const refs = [{kind: 'pr', label: 'OpenCCU-Base #9'}];
    const job = {
        id: 'main-release',
        ref: 'main',
        variant: 'release',
        counts: {pass: 2, fail: 0, todo: 0, skip: 0},
        knownBroken: [],
        tests: [
            {...t('a'), refs},
            {...t('z'), refs: []},
        ],
    };
    const report = buildReport({jobs: [job], fuzz: []}, {proof, generatedAt: '2026-10-11T12:00:00Z'});
    assert.equal(report.proof, proof);
    assert.equal(report.jobs[0].tests[0].proof.status, 'proven');
    assert.equal(report.jobs[0].tests[1].proof, undefined);
});
