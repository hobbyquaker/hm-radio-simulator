import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {collectResults, buildReport, renderSummaryMarkdown, renderHtml, writeSite} from '../../scripts/report.mjs';
import {describeTest} from '../metadata.js';

const FIXTURE = new URL('../fixtures/report/', import.meta.url).pathname;

test('describeTest: pull requests in the name become regression links, findings known-bug links', () => {
    const reg = describeTest('#138 on hs485d: a nested system.multicall is refused, hs485d stays up');
    assert.equal(reg.kind, 'regression');
    assert.deepEqual(
        reg.refs.map((r) => r.url),
        [
            'https://github.com/OpenCCU/OpenCCU-Base/pull/138',
            'https://github.com/OpenCCU/OpenCCU-Base/commit/0d71a252d1d3c0b9ddd77410cc3db2e864c1e6ec',
        ],
    );
    const known = describeTest(
        'init with an empty id deregisters the receiver and rfd stays up (the double-join finding under ASan)',
    );
    assert.equal(known.kind, 'known-bug');
    assert.ok(known.refs[0].url.endsWith('upstream-reports/001-double-join.md'), known.refs[0].url);
    const viaTodo = describeTest('no busy loop after the hangup', {
        todo: 'the read-eof finding is not fixed in this BASE_REF',
    });
    assert.equal(viaTodo.kind, 'known-bug');
    assert.equal(describeTest('frame fuzzing: random frames on the pty (seeded)').kind, 'fuzz');
    assert.equal(describeTest('rfd initialises the simulated module').kind, 'behaviour');
});

test('collectResults finds the jobs and fuzz runs below the fixture; buildReport sums them up', () => {
    const results = collectResults([FIXTURE]);
    assert.deepEqual(
        results.jobs.map((j) => j.id),
        ['3.89.11-release', 'main-coverage', 'main-release'],
    );
    assert.equal(results.fuzz.length, 1);
    assert.deepEqual(results.jobs[0].counts, {pass: 3, fail: 0, todo: 2, skip: 0});
    assert.equal(results.jobs[0].tests[0].kind, 'regression');
    const report = buildReport(results, {
        repoSha: 'abcdef0123456789',
        runId: '42',
        runUrl: 'https://example.invalid/run/42',
        generatedAt: '2026-10-10T18:05:00.000Z',
    });
    assert.equal(report.status, 'fail', 'main has a failure');
    assert.equal(report.id, '20261010-1805-abcdef0');
});

test('the Markdown summary lists the jobs, the failure and the known-broken tests with links', () => {
    const report = buildReport(collectResults([FIXTURE]), {
        repoSha: 'abcdef0123456789',
        generatedAt: '2026-10-10T18:05:00.000Z',
    });
    const md = renderSummaryMarkdown(report);
    assert.match(
        md,
        /\| 3\.89\.11 \(\[3ed652a\]\(https:\/\/github.com\/OpenCCU\/OpenCCU-Base\/commit\/3ed652a4[0-9a-f]+\)\) \| release \| \d+ s \| 3 \| 0 \| 2 \| 0 \|/,
    );
    assert.match(
        md,
        /### Failures\n\n- ❌ \*\*rfd initialises the simulated module and reports the interface CONNECTED\*\* \(main, release\): rfd did not answer/,
    );
    assert.match(md, /\[OpenCCU-Base \\#138\]\(https:\/\/github.com\/OpenCCU\/OpenCCU-Base\/pull\/138\)/);
    assert.match(md, /fuzz_xmlparser \| 60 s \| 3456789 \| none/);
});

test('the HTML report has a column per job, the links, the diagnostics and no script', () => {
    const report = buildReport(collectResults([FIXTURE]), {
        repoSha: 'abcdef0123456789',
        generatedAt: '2026-10-10T18:05:00.000Z',
    });
    const html = renderHtml(report, [
        {
            id: 'x',
            generatedAt: '2026-10-09T10:00:00Z',
            repoSha: '1234567',
            status: 'pass',
            pass: 1,
            fail: 0,
            todo: 0,
            fuzzFindings: 0,
        },
    ]);
    assert.ok(html.startsWith('<!doctype html>'));
    assert.doesNotMatch(html, /<script/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.ok(html.includes('href="https://github.com/OpenCCU/OpenCCU-Base/pull/138"'));
    assert.ok(
        html.includes('href="https://github.com/OpenCCU/OpenCCU-Base/commit/0d71a252d1d3c0b9ddd77410cc3db2e864c1e6ec"'),
    );
    assert.ok(html.includes('rfd used 200 clock ticks in the 2 s after the hangup'));
    assert.ok(html.includes('runs/x/'), 'the history links to the kept run');
    assert.equal((html.match(/<th class="r">3\.89\.11<br>/g) || []).length, 2, 'a column per job in both file tables');
    // every table shares the column scheme: a colgroup, fixed layout, the result columns right-aligned
    assert.match(html, /table-layout: fixed/);
    const tables = html.match(/<table>[\s\S]*?<\/table>/g);
    assert.ok(tables.length >= 4, `tables: ${tables.length}`);
    // the test tables have one result column per job (two in the fixture), the others four
    for (const t of tables) {
        assert.match(t, /^<table><colgroup><col>/, 'the first column takes the rest');
        const expected = t.includes('<th class="">test</th>') ? report.jobs.length : 4;
        assert.equal((t.match(/<col class="r">/g) || []).length, expected, `result columns: ${t.slice(0, 200)}`);
        assert.equal((t.match(/<th class="r">/g) || []).length, expected, 'result headers');
    }
    assert.match(html, /col\.d \{ width: 1px; \}/, 'secondary columns shrink away at phone width');
});

test('writeSite keeps the previous runs and caps the history', () => {
    const previous = fs.mkdtempSync(path.join(os.tmpdir(), 'hmrs-report-prev-'));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hmrs-report-out-'));
    try {
        fs.mkdirSync(path.join(previous, 'runs', 'old-run'), {recursive: true});
        fs.writeFileSync(path.join(previous, 'runs', 'old-run', 'index.html'), '<!doctype html>old');
        fs.writeFileSync(
            path.join(previous, 'history.json'),
            JSON.stringify([
                {
                    id: 'old-run',
                    generatedAt: '2026-10-09T10:00:00Z',
                    repoSha: '1234567',
                    status: 'pass',
                    pass: 1,
                    fail: 0,
                    todo: 0,
                    fuzzFindings: 0,
                },
                {
                    id: 'older',
                    generatedAt: '2026-10-08T10:00:00Z',
                    repoSha: '7654321',
                    status: 'pass',
                    pass: 1,
                    fail: 0,
                    todo: 0,
                    fuzzFindings: 0,
                },
            ]),
        );
        const report = buildReport(collectResults([FIXTURE]), {
            repoSha: 'abcdef0123456789',
            generatedAt: '2026-10-10T18:05:00.000Z',
        });
        const history = writeSite(report, {out, previous, keep: 2});
        assert.deepEqual(
            history.map((h) => h.id),
            ['20261010-1805-abcdef0', 'old-run'],
        );
        assert.ok(fs.existsSync(path.join(out, 'index.html')));
        assert.ok(fs.existsSync(path.join(out, 'runs', '20261010-1805-abcdef0', 'report.json')));
        assert.equal(fs.readFileSync(path.join(out, 'runs', 'old-run', 'index.html'), 'utf8'), '<!doctype html>old');
        assert.ok(fs.existsSync(path.join(out, '.nojekyll')));
        assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /hm-radio-simulator test report/);
    } finally {
        fs.rmSync(previous, {recursive: true, force: true});
        fs.rmSync(out, {recursive: true, force: true});
    }
});

test('coverage: the lcov summary per component, the section, the links and the history line', async () => {
    const {parseLcov, summarise, componentOf} = await import('../../scripts/coverage-summary.mjs');
    const lcov = fs.readFileSync(new URL('../fixtures/coverage/small.info', import.meta.url), 'utf8');
    const summary = summarise(parseLcov(lcov));
    assert.deepEqual(
        summary.components.map((c) => [c.component, c.kind, c.lines, c.files.length]),
        [
            ['rfd', 'daemon', 36.7, 2],
            ['hs485d', 'daemon', 10, 1],
            ['libXmlRpc', 'library', 70, 1],
        ],
    );
    assert.equal(componentOf('/x/src/libelvutils/Actor.cpp'), 'libelvutils');
    assert.equal(componentOf('/usr/include/c++/14/vector'), 'other');

    const results = collectResults([FIXTURE]);
    const coverageJob = results.jobs.find((j) => j.variant === 'coverage');
    assert.ok(coverageJob && coverageJob.coverage, 'the coverage job carries its summary');
    const report = buildReport(results, {repoSha: 'abcdef0123456789', generatedAt: '2026-10-10T18:05:00.000Z'});
    const md = renderSummaryMarkdown(report);
    assert.match(md, /\| main \| rfd \| 36\.7 % \(550\/1500\) \| 41\.7 % \| 24\.0 % \|/);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hmrs-report-cov-'));
    try {
        const history = writeSite(report, {out, keep: 5});
        assert.deepEqual(history[0].coverage, {main: {rfd: 36.7, hs485d: 10}});
        const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
        assert.match(html, /<h2>Coverage<\/h2>/);
        assert.ok(html.includes('lcov tracefile'), 'the data file is linked');
        assert.ok(
            fs.existsSync(path.join(out, 'runs', report.id, 'coverage-main-030dba7-abcdef0.info')),
            'the tracefile is published',
        );
        assert.ok(html.includes('coverage main: rfd 36.7 %, hs485d 10.0 %'), 'the history line');
    } finally {
        fs.rmSync(out, {recursive: true, force: true});
    }
});
