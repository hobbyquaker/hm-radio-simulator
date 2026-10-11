import {test} from 'node:test';
import assert from 'node:assert/strict';

import {collectResults, buildReport, renderHtml} from '../../scripts/report.mjs';
import {trendOf, series, change, sparkline, renderTrendPanel, daemonOf} from '../../scripts/trend.mjs';

const FIXTURE = new URL('../fixtures/report/', import.meta.url).pathname;

/** A history entry with a trend for each ref given. */
function entry(id, day, trend) {
    return {id, generatedAt: `2026-10-${day}T10:00:00Z`, repoSha: `${id}000000`, trend};
}
const counts = (pass, todo, fail, skip = 0) => ({pass, todo, fail, skip});
const t = (commit, rfd, hs485d, coverage) => ({baseCommit: `${commit}${'0'.repeat(33)}`, rfd, hs485d, coverage});

test('trendOf: per ref and daemon the combined counts, and the coverage per daemon and in total', () => {
    const report = buildReport(collectResults([FIXTURE]), {generatedAt: '2026-10-10T18:05:00.000Z'});
    const trend = trendOf(report);
    assert.deepEqual(Object.keys(trend), ['3.89.11', 'main']);
    // main: release + ASan + coverage combine; the hs485d test is the #138 one
    assert.deepEqual(trend.main.hs485d, counts(1, 0, 0));
    assert.equal(trend.main.rfd.fail, 2, 'rfd initialises (release+ASan) and frame fuzzing (ASan only)');
    assert.equal(trend.main.coverage.rfd, 36.7);
    assert.ok(trend.main.coverage.total > 0);
    assert.deepEqual(trend['3.89.11'].coverage, {rfd: null, hs485d: null, total: null}, 'no coverage job: a gap');
    assert.equal(daemonOf({file: 'test/daemon/receiver-contract.test.js', name: 'hs485d: three receivers'}), 'hs485d');
    assert.equal(daemonOf({file: 'test/daemon/receiver-contract.test.js', name: 'rfd: three receivers'}), 'rfd');
});

test('series and change: rising, falling and unchanged values, gaps where a run has no value', () => {
    // newest first, as history.json keeps it
    const history = [
        entry('d', '11', {main: t('d', counts(110, 20, 0), counts(30, 2, 1), {rfd: 41, hs485d: 30, total: 35})}),
        entry('c', '10', {main: t('c', counts(105, 20, 2), counts(30, 2, 0), {rfd: 40, hs485d: 30, total: 35})}),
        entry('b', '09', {main: t('b', counts(100, 21, 3), counts(30, 2, 0), {rfd: null, hs485d: null, total: null})}),
        entry('a', '08', {main: t('a', counts(98, 22, 3), counts(30, 2, 0), {rfd: 38, hs485d: 31, total: 34})}),
    ];
    const pass = series(history, 'main', ['rfd', 'pass']);
    assert.deepEqual(
        pass.map((p) => p.value),
        [98, 100, 105, 110],
        'oldest first',
    );
    assert.deepEqual(change(pass), {delta: 5, sign: '▲'});
    assert.deepEqual(change(series(history, 'main', ['rfd', 'fail'])), {delta: -2, sign: '▼'});
    assert.deepEqual(change(series(history, 'main', ['hs485d', 'pass'])), {delta: 0, sign: '='});
    const cov = series(history, 'main', ['coverage', 'hs485d']);
    assert.deepEqual(
        cov.map((p) => p.value),
        [31, null, 30, 30],
        'a run without coverage is a gap',
    );
    const svg = sparkline(series(history, 'main', ['coverage', 'rfd']), {unit: ' %', ref: 'main'});
    assert.equal((svg.match(/<polyline/g) || []).length, 1, 'the gap breaks the line: one segment of two points');
    assert.equal((svg.match(/class="dot"/g) || []).length, 1, 'and a lone point before it');
    assert.match(svg, /aria-label="history: 38, 40, 41 %"/);
    assert.match(svg, /<title>2026-10-11 10:00 · d000000 · OpenCCU-Base d000000 · 41 %<\/title>/);
});

test('the panel: a card per ref with arrows coloured by meaning, a ref new in the window says so', () => {
    const report = buildReport(collectResults([FIXTURE]), {generatedAt: '2026-10-12T10:00:00.000Z'});
    const now = trendOf(report);
    const history = [
        {id: report.id, generatedAt: report.generatedAt, repoSha: 'e000000', trend: now},
        // 3.89.11 only from the previous run on (a new tag entered the window), main for longer
        entry('b', '11', {
            '3.89.11': t('3ed652a', counts(3, 2, 0), counts(1, 0, 0), {rfd: null, hs485d: null, total: null}),
            main: t('030dba7', counts(4, 1, 0), counts(1, 0, 0), {rfd: 30, hs485d: 10, total: 20}),
        }),
        entry('a', '10', {main: t('030dba7', counts(4, 1, 0), counts(1, 0, 0), {rfd: 30, hs485d: 10, total: 20})}),
    ];
    const html = renderTrendPanel(report, history);
    assert.equal((html.match(/<section class="trend-card">/g) || []).length, 2);
    assert.match(html, /<span class="tr-ref">3\.89\.11<\/span>[^]*?2 runs since 2026-10-11/);
    assert.match(html, /<span class="tr-ref">main<\/span>[^]*?3 runs since 2026-10-10/);
    // main rfd: fail 0 -> 2 is worse (red), coverage 30 -> 36.7 better (green)
    assert.match(html, /<span class="tn fail">2<\/span><span class="td bad"[^>]*>▲ 2<\/span>/);
    assert.match(html, /<span class="tn coverage">36\.7 %<\/span><span class="td good"[^>]*>▲ 6\.7<\/span>/);
    assert.match(html, /<span class="td same"[^>]*>=<\/span>/, 'an unchanged value');
    // the full page carries the panel at the top, before the cards; its only script is the filter's
    const page = renderHtml(report, history);
    assert.ok(page.indexOf('class="trend"') < page.indexOf('class="cards"'));
    assert.equal((page.match(/<script/g) || []).length, 1);
    assert.match(page, /\.trend \{ display: grid;/);
});
