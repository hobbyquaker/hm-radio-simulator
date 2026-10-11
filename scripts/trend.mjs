/**
 * The trend panel at the top of the report: per OpenCCU-Base ref a card with rfd's and hs485d's pass/todo/fail/skip
 * and the line coverage (per daemon and summed over everything the coverage variant measures), each value with a
 * sparkline over the kept history and its change against the previous run of that ref.
 *
 * Every history entry (history.json) carries a `trend` (trendOf below): per ref the combined counts per daemon
 * (scripts/combine.mjs - a test counts with its worst variant) and the coverage. Entries written before the trend
 * existed get it from their runs/<id>/report.json when the site is written. A run without coverage data leaves a gap,
 * never a zero. Inline SVG, no JavaScript; the arrows and signs carry the meaning, colour only underlines it.
 */

import {groupByRef, combine} from './combine.mjs';

/** Which daemon a test belongs to: hs485d when its file or name says so, else rfd. */
export function daemonOf(test) {
    return /hs485d/.test(test.file || '') || /^hs485d\b/.test(test.name || '') ? 'hs485d' : 'rfd';
}

const pct = (hit, total) => (total > 0 ? Math.round((1000 * hit) / total) / 10 : null);

/**
 * The trend values of one report.
 * @returns {Record<string, {baseCommit: string, rfd: object, hs485d: object, coverage: {rfd: number|null,
 *   hs485d: number|null, total: number|null}}>}
 */
export function trendOf(report) {
    const out = {};
    const rows = new Map();
    for (const job of report.jobs || []) {
        for (const t of job.tests || []) {
            const key = `${t.file}\u0000${t.nesting}\u0000${t.name}`;
            if (!rows.has(key)) {
                rows.set(key, {test: t, results: new Map()});
            }
            rows.get(key).results.set(job.id, t);
        }
    }
    for (const ref of groupByRef(report.jobs || [])) {
        const counts = {rfd: {pass: 0, todo: 0, fail: 0, skip: 0}, hs485d: {pass: 0, todo: 0, fail: 0, skip: 0}};
        for (const row of rows.values()) {
            const c = combine(row.results, ref);
            if (c) {
                counts[daemonOf(row.test)][c.status] += 1;
            }
        }
        const cov = ref.jobs.find((j) => j.coverage);
        const comps = cov ? cov.coverage.components : [];
        const daemon = (name) => {
            const c = comps.find((x) => x.component === name);
            return c ? pct(c.linesHit, c.linesTotal) : null;
        };
        const hit = comps.reduce((s, c) => s + (c.linesHit || 0), 0);
        const total = comps.reduce((s, c) => s + (c.linesTotal || 0), 0);
        out[ref.ref] = {
            baseCommit: ref.baseCommit,
            ...counts,
            coverage: {rfd: daemon('rfd'), hs485d: daemon('hs485d'), total: cov ? pct(hit, total) : null},
        };
    }
    return out;
}

const esc = (text) =>
    String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

/**
 * One series from the history (oldest first): the value at `path` of `ref`'s trend in each run, null where the run
 * has no such value (the ref was not tested, or no coverage).
 * @param {object[]} history newest first, as history.json keeps it
 */
export function series(history, ref, path) {
    return [...history].reverse().map((entry) => {
        const t = entry.trend && entry.trend[ref];
        let v = t;
        for (const p of path) {
            v = v == null ? null : v[p];
        }
        return {entry, value: typeof v === 'number' ? v : null};
    });
}

/**
 * The change of the last value against the previous one that exists.
 * @returns {{delta: number|null, sign: '▲'|'▼'|'='|''}}
 */
export function change(points) {
    const values = points.map((p) => p.value).filter((v) => v !== null);
    // no change to show when the latest run has no value (a gap is not a change)
    if (values.length < 2 || !points.length || points[points.length - 1].value === null) {
        return {delta: null, sign: ''};
    }
    const delta = Math.round((values[values.length - 1] - values[values.length - 2]) * 10) / 10;
    return {delta, sign: delta > 0 ? '▲' : delta < 0 ? '▼' : '='};
}

/**
 * An inline SVG sparkline: a line through the points (broken at gaps), the last point marked, a <title> per point
 * with the run's date, commits and value.
 */
export function sparkline(points, {width = 96, height = 22, unit = '', ref = ''} = {}) {
    const values = points.map((p) => p.value).filter((v) => v !== null);
    const label = `${values.length ? values.join(', ') : 'no data'}${unit}`;
    if (!values.length) {
        return `<svg class="spark" width="${width}" height="${height}" role="img" aria-label="no data"></svg>`;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = 3;
    const n = points.length;
    const x = (i) => (n === 1 ? width - pad : pad + ((width - 2 * pad) * i) / (n - 1));
    const y = (v) => (max === min ? height / 2 : height - pad - ((height - 2 * pad) * (v - min)) / (max - min));
    const segments = [];
    let current = [];
    points.forEach((p, i) => {
        if (p.value === null) {
            if (current.length) {
                segments.push(current);
            }
            current = [];
        } else {
            current.push(`${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
        }
    });
    if (current.length) {
        segments.push(current);
    }
    const lines = segments
        .map((s) =>
            s.length > 1
                ? `<polyline points="${s.join(' ')}"/>`
                : `<circle class="dot" cx="${s[0].split(',')[0]}" cy="${s[0].split(',')[1]}" r="1.3"/>`,
        )
        .join('');
    const tips = points
        .map((p, i) =>
            p.value === null
                ? ''
                : `<circle class="hit" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4"><title>${esc(`${(p.entry.generatedAt || '').slice(0, 16).replace('T', ' ')} · ${(p.entry.repoSha || '').slice(0, 7)}${p.entry.trend && p.entry.trend[ref] ? ` · OpenCCU-Base ${p.entry.trend[ref].baseCommit.slice(0, 7)}` : ''} · ${p.value}${unit}`)}</title></circle>`,
        )
        .join('');
    const lastIndex = points.map((p) => p.value !== null).lastIndexOf(true);
    const last = `<circle class="last" cx="${x(lastIndex).toFixed(1)}" cy="${y(points[lastIndex].value).toFixed(1)}" r="2"/>`;
    return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(`history: ${label}`)}">${lines}${last}${tips}</svg>`;
}

/** The meaning of a change: good, bad or neutral (the colour; the arrow carries it too). */
function tone(metric, sign) {
    if (sign === '=' || sign === '') {
        return 'same';
    }
    const up = sign === '▲';
    if (metric === 'pass' || metric === 'coverage') {
        return up ? 'good' : 'bad';
    }
    if (metric === 'fail') {
        return up ? 'bad' : 'good';
    }
    return 'neutral';
}

function cell(points, metric, {unit = '', ref = '', title = ''} = {}) {
    // the line starts where the ref has its first value (a tag that entered the window later, coverage added later)
    const first = points.findIndex((p) => p.value !== null);
    if (first > 0) {
        points = points.slice(first);
    }
    // a count is missing only when a run did not test the ref at all: the line goes on; a coverage value can be
    // missing because the run had no coverage data, and that stays a visible gap
    if (metric !== 'coverage') {
        points = points.filter((p) => p.value !== null);
    }
    const lastPoint = points[points.length - 1];
    const value = lastPoint ? lastPoint.value : null;
    const {delta, sign} = change(points);
    const deltaText = sign === '' ? '' : sign === '=' ? '=' : `${sign} ${Math.abs(delta)}`;
    return `<div class="tv"><span class="tl">${esc(title)}</span><span class="tn ${metric}">${value === null ? '–' : `${value}${unit}`}</span><span class="td ${tone(metric, sign)}" title="${sign ? 'against the previous run' : 'no previous run'}">${esc(deltaText)}</span>${sparkline(points, {unit, ref})}</div>`;
}

/**
 * The panel: one card per ref of the current report.
 * @param {object} report the current report
 * @param {object[]} history newest first, the current run's entry included (with its trend)
 */
export function renderTrendPanel(report, history) {
    const refs = groupByRef(report.jobs || []);
    if (!refs.length) {
        return '';
    }
    const cards = refs.map(({ref, baseCommit}) => {
        const withRef = history.filter((e) => e.trend && e.trend[ref]);
        const oldest = withRef[withRef.length - 1];
        const since = oldest ? (oldest.generatedAt || '').slice(0, 10) : '';
        const runs = withRef.length;
        const part = (daemon) =>
            ['pass', 'todo', 'fail', 'skip']
                .map((m) => cell(series(history, ref, [daemon, m]), m, {ref, title: m}))
                .join('');
        const cov = [
            ['rfd', 'rfd'],
            ['hs485d', 'hs485d'],
            ['total', 'all'],
        ]
            .map(([k, label]) =>
                cell(series(history, ref, ['coverage', k]), 'coverage', {unit: ' %', ref, title: label}),
            )
            .join('');
        return `<section class="trend-card"><header><span class="tr-ref">${esc(ref)}</span> <a class="mono muted" href="https://github.com/OpenCCU/OpenCCU-Base/commit/${esc(baseCommit)}">${esc(baseCommit.slice(0, 7))}</a><span class="muted tr-since">${runs > 1 ? `${runs} runs since ${esc(since)}` : 'first run of this ref'}</span></header><div class="tr-row"><span class="tr-name">rfd</span>${part('rfd')}</div><div class="tr-row"><span class="tr-name">hs485d</span>${part('hs485d')}</div><div class="tr-row"><span class="tr-name">coverage</span>${cov}</div></section>`;
    });
    return `<div class="trend" aria-label="trend per OpenCCU-Base ref">${cards.join('')}</div><p class="muted trend-note">Per ref: the latest run's results per daemon (a test counts with its worst variant) and the line coverage, with the change against the previous run of that ref (▲/▼, = unchanged; green better, red worse) and a sparkline over the kept runs (hover a point for its date and commits). A gap is a run without that value.</p>`;
}

export const TREND_CSS = `
.trend { display: grid; grid-template-columns: repeat(auto-fit, minmax(24rem, 1fr)); gap: .75rem; margin: 1rem 0 .25rem; }
.trend-card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: .6rem .8rem; }
.trend-card header { display: flex; gap: .5rem; align-items: baseline; flex-wrap: wrap; margin-bottom: .3rem; }
.tr-ref { font-weight: 700; font-size: 1.05rem; } .tr-since { margin-left: auto; font-size: .8rem; }
.tr-row { display: grid; grid-template-columns: 4.6rem repeat(4, minmax(0, 1fr)); gap: .3rem; align-items: center;
  padding: .25rem 0; border-top: 1px solid var(--line); }
.tr-row:nth-of-type(3) { grid-template-columns: 4.6rem repeat(3, minmax(0, 1fr)); }
.tr-name { font-weight: 600; font-size: .85rem; color: var(--muted); }

.tv { display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: .35rem; min-width: 0;
  align-items: baseline; }
.tl { grid-column: 1 / 3; font-size: .7rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.tn { font-weight: 650; font-variant-numeric: tabular-nums; font-size: .95rem; }
.tn.pass { color: var(--pass); } .tn.fail { color: var(--fail); } .tn.todo { color: var(--todo); } .tn.skip { color: var(--skip); }
.td { font-size: .72rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.td.good { color: var(--pass); } .td.bad { color: var(--fail); } .td.neutral, .td.same { color: var(--muted); }
.spark { grid-column: 1 / 3; display: block; margin-top: 1px; overflow: visible; width: 100%; max-width: 96px; height: auto; }
.spark polyline { fill: none; stroke: var(--muted); stroke-width: 1.4; stroke-linejoin: round; stroke-linecap: round; }
.spark .dot { fill: var(--muted); } .spark .last { fill: var(--fg); } .spark .hit { fill: transparent; }
.spark .hit:hover { fill: var(--link); fill-opacity: .35; }
.trend-note { font-size: .8rem; margin-top: .2rem; }
@media (max-width: 760px) { .trend { grid-template-columns: 1fr; }
  .tr-row { grid-template-columns: 4.4rem repeat(4, minmax(0, 1fr)); } .tr-name { font-size: .78rem; }
  .tr-row:nth-of-type(3) { grid-template-columns: 4.4rem repeat(3, minmax(0, 1fr)); }
  .tv { grid-template-columns: auto minmax(0, 1fr); } .spark { width: 100%; max-width: 96px; } }
`;
