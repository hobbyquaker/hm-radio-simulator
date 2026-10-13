import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    collectResults,
    buildReport,
    renderSummaryMarkdown,
    renderHtml,
    writeSite,
    missingDescriptions,
    proofMark,
    proofText,
    triggerHtml,
} from '../../scripts/report.mjs';
import {combine, groupByRef} from '../../scripts/combine.mjs';
import {describe} from '../descriptions.js';
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
        ['3.89.11-release', 'main-release', 'main-asan', 'main-coverage'],
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
    // one row per ref, the variants with their durations, the combined counts
    assert.match(
        md,
        /\| OpenCCU\/OpenCCU-Base\/main 3\.89\.11 \(\[3ed652a\]\(https:\/\/github.com\/OpenCCU\/OpenCCU-Base\/commit\/3ed652a4[0-9a-f]+\)\) \| release \d+ s \| 3 \| 0 \| 2 \| 0 \|/,
    );
    assert.match(
        md,
        /\| OpenCCU\/OpenCCU-Base\/main head \(\[030dba7\]\([^)]+\)\) \| release \d+ s · asan \d+ s · coverage \d+ s \| 3 \| 2 \| 1 \| 0 \|/,
    );
    assert.match(
        md,
        /### Failures\n\n- ❌ \*\*rfd initialises the simulated module and reports the interface CONNECTED\*\* \(OpenCCU\/OpenCCU-Base\/main head: release, asan\): rfd did not answer/,
    );
    assert.match(md, /### Where the variants differ\n\n[^]*frame fuzzing[^\n]* - main: release ✅ asan ❌/);
    assert.match(md, /\[OpenCCU-Base \\#138\]\(https:\/\/github.com\/OpenCCU\/OpenCCU-Base\/pull\/138\)/);
    assert.match(md, /fuzz_xmlparser \| 60 s \| 3456789 \| none/);
});

test('combine: one result per ref - agreeing variants give one result, differing ones the worst plus chips', () => {
    const results = collectResults([FIXTURE]);
    const refs = groupByRef(results.jobs);
    assert.deepEqual(
        refs.map((r) => `${r.ref}:${r.jobs.map((j) => j.variant).join('+')}`),
        ['3.89.11:release', 'main:release+asan+coverage'],
    );
    const main = refs[1];
    const row = (name) => {
        const m = new Map();
        for (const j of results.jobs) {
            const t = j.tests.find((x) => x.name === name);
            if (t) {
                m.set(j.id, t);
            }
        }
        return m;
    };
    const agree = combine(row('#138 on hs485d: a nested system.multicall is refused, hs485d stays up'), main);
    assert.deepEqual([agree.status, agree.differs, agree.chips], ['pass', false, []]);
    const asanOnly = combine(
        row('frame fuzzing: random frames and garbage on the pty do not crash rfd (seeded)'),
        main,
    );
    assert.deepEqual([asanOnly.status, asanOnly.differs, asanOnly.chips], ['fail', true, ['A']]);
    // the coverage variant counts where it differs from release: release and ASan fail, coverage passes
    const cov = combine(row('rfd initialises the simulated module and reports the interface CONNECTED'), main);
    assert.deepEqual([cov.status, cov.differs, cov.chips], ['fail', true, ['R', 'A']]);
    assert.equal(combine(row('a test nobody explained yet'), refs[0]), null, 'not run on 3.89.11');
});

test('descriptions: every test needs one, a variant suffix finds the plain name', () => {
    assert.ok(
        describe(
            'test/daemon/rfd-rpc.test.js',
            'init with an empty id deregisters the receiver and rfd stays up (the double-join finding under ASan)',
        ),
    );
    assert.ok(describe('/opt/x/test/daemon/rfd-rpc.test.js', 'a getValue on an unknown address faults, rfd stays up'));
    assert.equal(describe('test/daemon/rfd-rpc.test.js', 'no such test'), null);
    const missing = missingDescriptions(collectResults([FIXTURE]));
    assert.deepEqual(missing, [{file: 'test/daemon/rfd-pty-module.test.js', name: 'a test nobody explained yet'}]);
});

test('the HTML report: one column per ref, one line per row with the explanation behind it, chips where variants differ', () => {
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
    assert.equal((html.match(/<script/g) || []).length, 1, 'one script: the filter (task 37)');
    assert.match(html, /prefers-color-scheme: dark/);
    assert.ok(html.includes('href="https://github.com/OpenCCU/OpenCCU-Base/pull/138"'));
    assert.ok(
        html.includes('href="https://github.com/OpenCCU/OpenCCU-Base/commit/0d71a252d1d3c0b9ddd77410cc3db2e864c1e6ec"'),
    );
    assert.ok(html.includes('rfd used 200 clock ticks in the 2 s after the hangup'));
    assert.ok(html.includes('runs/x/'), 'the history links to the kept run');
    // one result column per ref (two refs in the fixture), not per job: the repository and branch spans them above,
    // the tag or "head" names each below, its commit under it
    const refRe =
        /<th class="r">(3\.89\.11|head)<br><a class="mono muted" href="[^"]+\/commit\/[0-9a-f]+" title="[0-9a-f]{40}">/g;
    const refHeads = html.match(refRe) || [];
    assert.ok(refHeads.length >= 4 && refHeads.length % 2 === 0, `ref columns: ${refHeads.length}`);
    assert.match(
        html,
        /<th class="grp" colspan="2" scope="colgroup"><a href="https:\/\/github\.com\/OpenCCU\/OpenCCU-Base\/tree\/main">OpenCCU\/<wbr>OpenCCU-<wbr>Base\/<wbr>main<\/a><\/th>/,
    );
    assert.match(html, /<th class="" rowspan="2">test<\/th>/);
    // a missing fix reads "known" on the tag and "todo" on the head (the fixture's 3.89.11 and main)
    assert.match(html, /<span class="todo"[^>]*>⚠️ <span class="word">known<\/span>/);
    assert.match(html, /<span class="todo"[^>]*>⚠️ <span class="word">todo<\/span>/);
    assert.match(html, /known \/ todo/);
    assert.doesNotMatch(html, /<span class="muted">asan<\/span><\/th>/, 'no per-variant columns');
    // every test row is one line at load: the name is the summary of a closed <details>, cut with an ellipsis
    assert.match(
        html,
        /details\.row > summary \{ display: block; cursor: pointer; white-space: nowrap; overflow: hidden;/,
    );
    const rowDetails = html.match(/<td class="name"><details class="row"><summary>/g) || [];
    assert.ok(rowDetails.length >= 6, `rows with a collapsible: ${rowDetails.length}`);
    assert.doesNotMatch(html, /<details class="row" open/, 'all collapsed at load');
    for (const t of html.match(/<table[ >][\s\S]*?<\/table>/g).filter((x) => x.includes('<th class="">test</th>'))) {
        const names = t.match(/<td class="name">.{0,30}/g) || [];
        assert.ok(
            names.every((n) => n.startsWith('<td class="name"><details class="row"><summary>')),
            `every test row starts collapsed: ${names.find((n) => !n.includes('<details'))}`,
        );
    }
    // behind it, first the description of what the test does
    assert.ok(
        html.includes(
            `<p class="what">${describe('test/daemon/hs485d-rpc.test.js', '#138 on hs485d: a nested system.multicall is refused, hs485d stays up').replace(/'/g, '&#39;')}</p>`,
        ),
        'the description is rendered',
    );
    // where the variants differ: the worst result plus a chip naming the variant, a tooltip with each variant
    assert.match(
        html,
        /<span class="fail differs" title="release: pass [^"]*\nasan: fail [^"]*">❌ <span class="word">fail<\/span> <span class="chip fail">A<\/span><\/span>/,
    );
    assert.match(html, /<h2 id="differing">Rows where the variants differ<\/h2>/);
    assert.match(html, /<a href="#differing">Only the 2 row\(s\) where the variants differ<\/a>/);
    // the jobs table: one row per ref with the variants and their durations
    assert.match(html, /<span class="vd" title="asan: \d+ s">A \d+ s<\/span>/);
    // every table shares the column scheme: a colgroup, fixed layout, the result columns right-aligned and equal
    assert.match(html, /table-layout: fixed/);
    const tables = html.match(/<table[ >][\s\S]*?<\/table>/g);
    assert.match(html, /\.scroll \{ overflow-x: auto;/);
    assert.ok(
        tables.every((t) => /^<table style="min-width: calc\(var\(--w-name\) \+ /.test(t)),
        'every table has a min-width',
    );
    assert.equal(
        (html.match(/<div class="scroll"><table /g) || []).length,
        tables.length,
        'every table in a scroll box',
    );
    for (const t of tables) {
        assert.match(t, /^<table [^>]*><colgroup><col>/, 'the first column takes the rest');
        const expected = /<th class=""( rowspan="2")?>test<\/th>/.test(t) ? 2 : 4;
        assert.equal((t.match(/<col class="r">/g) || []).length, expected, `result columns: ${t.slice(0, 200)}`);
        assert.equal((t.match(/<th class="r">/g) || []).length, expected, 'result headers');
    }
    assert.match(html, /col\.d, col\.v \{ width: 1px; \}/, 'secondary columns shrink away at phone width');
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
        assert.ok(
            html.includes('coverage OpenCCU/OpenCCU-Base/main head: rfd 36.7 %, hs485d 10.0 %'),
            'the history line',
        );
    } finally {
        fs.rmSync(out, {recursive: true, force: true});
    }
});

test('the regression proof (task 30): a mark in the kind cell, the commits behind the collapsible, a card with the counts', () => {
    const results = collectResults([FIXTURE]);
    const t = results.jobs[1].tests.find((x) => x.name.startsWith('#138'));
    t.proof = {status: 'proven', fix: 138, parent: 'a'.repeat(40), merge: 'b'.repeat(40), date: '2026-10-11T12:00:00Z'};
    const report = buildReport(results, {generatedAt: '2026-10-11T13:00:00.000Z'});
    report.proof = {
        generatedAt: '2026-10-11T12:00:00Z',
        fixes: {
            138: {status: 'proven'},
            140: {status: 'proven'},
            115: {status: 'not-proven'},
            116: {status: 'inconclusive'},
        },
    };
    const html = renderHtml(report, []);
    assert.match(html, /<span class="proof proven" title="proven for #138: [^"]+">✓ proven<\/span>/);
    assert.ok(html.includes('Proof: <span class="proof proven">proven</span>'));
    assert.ok(
        html.includes(`href="https://github.com/OpenCCU/OpenCCU-Base/commit/${'a'.repeat(40)}"`),
        'the parent linked',
    );
    assert.match(html, /<div class="big fail">2\/4<\/div><div class="label">fixes proven/);
    assert.match(proofMark({status: 'not-proven', fix: 115}), /class="proof not-proven"[^>]*>✗ not proven/);
    assert.match(proofText({status: 'inconclusive', fix: 116}), /inconclusive/);
    // a fork fix: the issue, and the commits in the fork
    const fork = proofText({
        status: 'proven',
        fix: 164,
        parent: 'c'.repeat(40),
        merge: 'd'.repeat(40),
        repo: 'https://github.com/hobbyquaker/OpenCCU-Base',
    });
    assert.ok(fork.includes('href="https://github.com/OpenCCU/OpenCCU-Base/issues/164"'), fork);
    assert.ok(
        fork.includes(
            `fork commit <a class="mono" href="https://github.com/hobbyquaker/OpenCCU-Base/commit/${'d'.repeat(40)}"`,
        ),
    );
    assert.ok(
        fork.includes(
            `parent <a class="mono" href="https://github.com/hobbyquaker/OpenCCU-Base/commit/${'c'.repeat(40)}"`,
        ),
    );
});

test('a fork column links its commits in the fork; a fork or tag trigger is linked where the commit is', () => {
    assert.equal(
        triggerHtml(`lite ${'e'.repeat(40)}`),
        `hobbyquaker/OpenCCU-Base/lite head <a class="mono" href="https://github.com/hobbyquaker/OpenCCU-Base/commit/${'e'.repeat(40)}">eeeeeee</a>`,
    );
    assert.match(
        triggerHtml(`lite@v1.0.0-beta.3 ${'e'.repeat(40)}`),
        /^hobbyquaker\/OpenCCU-Base\/lite 1\.0\.0-beta\.3 <a class="mono" href="https:\/\/github\.com\/hobbyquaker\/OpenCCU-Base\/commit\/e{40}">/,
    );
    assert.match(
        triggerHtml('3.89.12 abcdef1'),
        /^OpenCCU\/OpenCCU-Base\/main 3\.89\.12 .*OpenCCU\/OpenCCU-Base\/commit\/abcdef1/,
    );
    assert.equal(triggerHtml('lite-3.89.11 abcdef1'), 'lite-3.89.11 abcdef1', 'an unknown label is plain text');
    assert.match(triggerHtml('OpenCCU-Base 1234567'), /OpenCCU\/OpenCCU-Base\/commit\/1234567/);
    assert.equal(triggerHtml('push <b>'), 'push &lt;b&gt;');
});

test('the filter bar (task 37): hidden without JavaScript, chips with counts, rows carry what the filter matches', () => {
    const report = buildReport(collectResults([FIXTURE]), {generatedAt: '2026-10-11T13:00:00.000Z'});
    const html = renderHtml(report, []);
    // without JavaScript the bar stays hidden and no row is hidden
    assert.match(html, /<form class="filter" id="filter" hidden role="search"/);
    assert.doesNotMatch(html, /<tr data-row[^>]* hidden/);
    // the counts over the unique rows of the file tables (6 tests in the fixture)
    const count = (token) => {
        const m = new RegExp(`value="${token}" data-group="[^"]+"> [^<]+ <span class="fcount">(\\d+)</span>`).exec(
            html,
        );
        return m ? Number(m[1]) : 0;
    };
    assert.equal(count('fail'), 2, 'two rows fail somewhere');
    assert.equal(count('differs'), 2);
    assert.equal(count('hs485d'), 1);
    assert.equal(count('rfd'), 5);
    assert.equal(count('regression'), 2, '#138 and the #115/#116 module-lost test');
    assert.equal(count('r1-fail'), 2, 'fails on main (column 1)');
    assert.equal(count('r0-fail'), 0, 'nothing fails on 3.89.11: no chip');
    assert.match(html, /<span id="fshown" aria-live="polite">6 of 6 tests shown<\/span>/);
    // a row carries its results per ref, daemon, kind and the searchable text
    assert.match(
        html,
        /<tr data-row="" data-result="todo pass" data-daemon="hs485d" data-kind="regression" data-differs="no" data-proof="" data-text="#138 on hs485d[^"]*" data-r0="todo" data-r1="pass">/,
    );
    assert.match(html, /<section class="test-file"><h3 class="mono">test\/daemon\/rfd-pty-module\.test\.js<\/h3>/);
});

test("describeTest: a finding's issue number in the name links the issue and the fork commit, not a pull request", () => {
    const {kind, refs} = describeTest(
        '#164 SIGTERM: hs485d behind the wired LAN gateway leaves its main loop and exits 0',
    );
    assert.equal(kind, 'regression');
    assert.deepEqual(
        refs.map((r) => [r.kind, r.url]),
        [
            ['issue', 'https://github.com/OpenCCU/OpenCCU-Base/issues/164'],
            ['commit', 'https://github.com/hobbyquaker/OpenCCU-Base/commit/2386c07aca3c5763336b62ba2c582bd38f5e815c'],
        ],
    );
    // the finding's name and its number in one name: one set of links
    const both = describeTest('rfd: init ... (the init-blocks finding, #170)');
    assert.equal(both.kind, 'known-bug');
    assert.equal(both.refs.filter((r) => r.kind === 'issue').length, 1);
});
