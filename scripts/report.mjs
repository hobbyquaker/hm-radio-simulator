#!/usr/bin/env node
/**
 * The test report: merges the results of the daemon suites (results/<variant>/tests.json + meta.json, written by the
 * JSON reporter and the entrypoint) and the fuzz runs (results/fuzz/summary.json) of one CI run into
 *
 *   report.json   the run as data
 *   summary.md    a Markdown overview for $GITHUB_STEP_SUMMARY
 *   index.html    a static page (inline CSS, dark mode, no JavaScript) for GitHub Pages
 *   history.json  the last runs, with the new one first
 *   runs/<id>/    the page and data of every run kept in the history
 *
 * Usage:
 *   report.mjs collect --out <site dir> [--previous <dir with the published site>] [--repo-sha <sha>]
 *                      [--run-id <id>] [--run-url <url>] [--ref <git ref>] [--keep 20] <results dir>...
 *   report.mjs summary <results dir>...        print the Markdown overview of these results only
 *
 * The test names carry their upstream references (see test/metadata.js), so a regression test links to the pull
 * request and commit that fixed the bug, a known finding to its issue or, until one exists, to the README.
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {describeTest} from '../test/metadata.js';

const REPO = 'https://github.com/hobbyquaker/hm-radio-simulator';
const BASE = 'https://github.com/OpenCCU/OpenCCU-Base';

// ---------------------------------------------------------------------------------------------------------------
// collecting

/**
 * Finds every daemon result (a meta.json next to a tests.json) and fuzz summary below the given directories.
 * @param {string[]} roots
 * @returns {{jobs: object[], fuzz: object[]}}
 */
export function collectResults(roots) {
    const jobs = [];
    const fuzz = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true});
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'work' || entry.name === 'corpus' || entry.name === 'node_modules') {
                    continue;
                }
                walk(full);
            } else if (entry.name === 'meta.json') {
                const meta = readJson(full);
                const testsFile = path.join(dir, 'tests.json');
                const tests = fs.existsSync(testsFile) ? readJson(testsFile) : {counts: {}, tests: []};
                jobs.push(makeJob(meta, tests));
            } else if (entry.name === 'fuzz-summary.json') {
                fuzz.push(readJson(full));
            }
        }
    };
    for (const root of roots) {
        walk(root);
    }
    jobs.sort((a, b) => a.ref.localeCompare(b.ref) || a.variant.localeCompare(b.variant));
    fuzz.sort((a, b) => a.ref.localeCompare(b.ref));
    return {jobs, fuzz};
}

function makeJob(meta, results) {
    const tests = (results.tests || []).map((t) => {
        const {kind, refs} = describeTest(t.name, t);
        return {...t, kind, refs};
    });
    const counts = {pass: 0, fail: 0, todo: 0, skip: 0};
    for (const t of tests) {
        counts[t.status] = (counts[t.status] || 0) + 1;
    }
    return {
        id: `${meta.ref}-${meta.variant}`,
        ref: meta.ref,
        baseCommit: meta.baseCommit,
        variant: meta.variant,
        knownBroken: meta.knownBroken || [],
        node: meta.node,
        startedAt: meta.startedAt,
        durationMs: Math.round(tests.filter((t) => t.nesting === 0).reduce((s, t) => s + (t.durationMs || 0), 0)),
        counts,
        tests,
    };
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {{jobs: object[], fuzz: object[]}} results
 * @param {{repoSha?: string, runId?: string, runUrl?: string, ref?: string, generatedAt?: string}} run
 */
export function buildReport(results, run = {}) {
    const generatedAt = run.generatedAt || new Date().toISOString();
    const sha = run.repoSha || '';
    const id = `${generatedAt.slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}${sha ? `-${sha.slice(0, 7)}` : ''}`;
    const status = overallStatus(results);
    return {
        id,
        generatedAt,
        repoSha: sha,
        repoUrl: sha ? `${REPO}/commit/${sha}` : REPO,
        ref: run.ref || '',
        runId: run.runId || '',
        runUrl: run.runUrl || '',
        status,
        jobs: results.jobs,
        fuzz: results.fuzz,
    };
}

/** Fuzz findings that are not expected on that ref (an old tag has known ones). */
export function unexpectedFuzzFindings(fuzz) {
    return fuzz
        .filter((f) => !f.expected)
        .reduce((n, f) => n + f.harnesses.reduce((m, h) => m + h.findings.length, 0), 0);
}

function overallStatus(results) {
    const failed = results.jobs.some((j) => j.counts.fail > 0) || unexpectedFuzzFindings(results.fuzz) > 0;
    return failed ? 'fail' : 'pass';
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown

const STATUS_MARK = {pass: '✅', fail: '❌', todo: '⚠️', skip: '⏭️'};

export function renderSummaryMarkdown(report) {
    const lines = [];
    lines.push(`## hm-radio-simulator test report`);
    lines.push('');
    lines.push(
        `${report.status === 'pass' ? '✅' : '❌'} ${report.status === 'pass' ? 'green' : 'red'} - ${report.generatedAt}${report.repoSha ? ` - [${report.repoSha.slice(0, 7)}](${report.repoUrl})` : ''}`,
    );
    lines.push('');
    if (report.jobs.length) {
        lines.push('| OpenCCU-Base | daemons | duration | pass | fail | todo (known) | skip |');
        lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
        for (const job of report.jobs) {
            lines.push(
                `| ${job.ref} ([${short(job.baseCommit)}](${BASE}/commit/${job.baseCommit})) | ${job.variant} | ${seconds(job.durationMs)} | ${job.counts.pass} | ${job.counts.fail} | ${job.counts.todo} | ${job.counts.skip} |`,
            );
        }
        lines.push('');
        const failing = report.jobs.flatMap((j) =>
            j.tests.filter((t) => t.status === 'fail').map((t) => ({job: j, test: t})),
        );
        if (failing.length) {
            lines.push('### Failures');
            lines.push('');
            for (const {job, test} of failing) {
                lines.push(
                    `- ❌ **${escapeMd(test.name)}** (${job.ref}, ${job.variant})${test.error ? `: ${escapeMd(test.error)}` : ''}`,
                );
            }
            lines.push('');
        }
        const todo = new Map();
        for (const job of report.jobs) {
            for (const t of job.tests.filter((t) => t.status === 'todo')) {
                const key = t.name;
                if (!todo.has(key)) {
                    todo.set(key, {test: t, jobs: []});
                }
                todo.get(key).jobs.push(`${job.ref} ${job.variant}`);
            }
        }
        if (todo.size) {
            lines.push('### Known broken on these refs (run as todo)');
            lines.push('');
            for (const {test, jobs} of todo.values()) {
                lines.push(`- ⚠️ ${escapeMd(test.name)} - ${jobs.join(', ')}${linksMd(test.refs)}`);
            }
            lines.push('');
        }
    }
    if (report.fuzz.length) {
        lines.push('### Fuzzing');
        lines.push('');
        lines.push('| OpenCCU-Base | harness | time | executions | findings |');
        lines.push('| --- | --- | ---: | ---: | ---: |');
        for (const run of report.fuzz) {
            for (const h of run.harnesses) {
                lines.push(
                    `| ${run.ref} ([${short(run.baseCommit)}](${BASE}/commit/${run.baseCommit})) | ${h.name} | ${h.seconds} s | ${h.execs ?? '?'} | ${h.findings.length ? h.findings.map((f) => f.type).join(', ') + (run.expected ? ' (expected on this ref)' : '') : 'none'} |`,
                );
            }
        }
        lines.push('');
    }
    return lines.join('\n');
}

function linksMd(refs) {
    if (!refs || !refs.length) {
        return '';
    }
    return ' (' + refs.map((r) => `[${escapeMd(r.label)}](${r.url})`).join(', ') + ')';
}

function escapeMd(text) {
    return String(text).replace(/\|/g, '\\|').replace(/#/g, '\\#');
}

function short(sha) {
    return sha ? String(sha).slice(0, 7) : '?';
}

function seconds(ms) {
    return ms ? `${(ms / 1000).toFixed(0)} s` : '-';
}

// ---------------------------------------------------------------------------------------------------------------
// HTML

const CSS = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d9d9de; --card: #f5f5f7;
  --pass: #2e7d32; --fail: #c62828; --todo: #b26a00; --skip: #607d8b; --link: #0b57d0; }
@media (prefers-color-scheme: dark) { :root { --bg: #16161a; --fg: #e7e7ea; --muted: #9a9aa3; --line: #34343c;
  --card: #1f1f26; --pass: #66bb6a; --fail: #ef5350; --todo: #ffb74d; --skip: #90a4ae; --link: #8ab4f8; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 1.5rem; font: 15px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg); color: var(--fg); max-width: 1400px; margin: 0 auto; }
a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; } h2 { font-size: 1.2rem; margin: 2rem 0 .75rem; }
h3 { font-size: 1rem; margin: 1.5rem 0 .5rem; color: var(--muted); font-weight: 600; }
.muted { color: var(--muted); } .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
.cards { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1rem 0; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: .75rem 1rem; min-width: 11rem; }
.card .big { font-size: 1.5rem; font-weight: 600; } .card .label { color: var(--muted); font-size: .85rem; }
/* every table: the name column takes the rest, the fixed columns share one width scheme, the four result columns at
   the right edge are --w-result wide and right-aligned in every table */
:root { --w-result: 6.5rem; --w-commit: 5.5rem; --w-small: 6rem; --w-kind: 7.5rem; --w-links: 11rem; }
.phone-only { display: none; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; table-layout: fixed; }
col.r { width: var(--w-result); } col.c { width: var(--w-commit); } col.s { width: var(--w-small); }
col.k { width: var(--w-kind); } col.l { width: var(--w-links); } col.d { width: var(--w-small); }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top;
  overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 600; font-size: .85rem; }
th.r, td.r { text-align: right; } td.r { white-space: nowrap; }
td.name { overflow-wrap: anywhere; }
.badge { display: inline-block; padding: 0 .5em; border-radius: 999px; font-size: .78em; font-weight: 600; line-height: 1.6;
  border: 1px solid currentColor; }
.pass { color: var(--pass); } .fail { color: var(--fail); } .todo { color: var(--todo); } .skip { color: var(--skip); }
.kind-regression { color: var(--link); } .kind-known-bug { color: var(--todo); } .kind-behaviour { color: var(--muted); }
.kind-fuzz { color: var(--pass); }
.sub { padding-left: 1.5rem; color: var(--muted); }
.diag { color: var(--muted); font-size: .85em; } .err { color: var(--fail); font-size: .85em; }
.overall-pass { color: var(--pass); } .overall-fail { color: var(--fail); }
footer { margin-top: 3rem; color: var(--muted); font-size: .85rem; }
/* phone: the commit, kind, links and duration columns shrink to a pixel (a zero width would count as auto) (their content moves under the name; the
   cells stay in the fixed layout so nothing shifts into the next <col>), the result columns keep one fixed width,
   the name wraps in the rest */
@media (max-width: 760px) { :root { --w-result: 3rem; --w-small: 3.6rem; }
  body { padding: .75rem; font-size: 13px; }
  th, td { padding: .35rem .3rem; }
  col.c, col.k, col.l, col.d { width: 1px; }
  th.c, th.k, th.l, th.d, td.c, td.k, td.l, td.d { padding: 0; border: 0; overflow: hidden; visibility: hidden;
    font-size: 0; line-height: 0; }
  td.r { white-space: normal; }
  .phone-only { display: block; margin-top: .2rem; } }
`;

/**
 * A table with a <colgroup>: the first column takes the remaining width, the others are fixed by their class
 * (`c` commit, `s` small, `d` duration, `k` kind, `l` links, `r` result - the result columns share one width and are
 * right-aligned; at phone width c, k, l and d leave the table).
 * @param {Array<{label: string, cls?: string, raw?: boolean}>} head
 * @param {string[][]} rows cells as HTML
 */
function table(head, rows) {
    const cols = head.map((c) => {
        const cls = (c.cls || '').split(' ').find((x) => ['r', 'c', 's', 'k', 'l', 'd'].includes(x));
        return cls ? `<col class="${cls}">` : '<col>';
    });
    const ths = head.map((c) => `<th class="${esc(c.cls || '')}">${c.raw ? c.label : esc(c.label)}</th>`);
    const trs = rows.map(
        (cells) =>
            `<tr>${cells.map((cell, i) => `<td class="${i === 0 ? 'name' : esc(head[i].cls || '')}">${cell}</td>`).join('')}</tr>`,
    );
    return `<table><colgroup>${cols.join('')}</colgroup><thead><tr>${ths.join('')}</tr></thead><tbody>\n${trs.join('\n')}\n</tbody></table>`;
}

export function renderHtml(report, history = []) {
    const jobs = report.jobs;
    const byName = new Map();
    for (const job of jobs) {
        for (const t of job.tests) {
            const key = `${t.file}\u0000${t.nesting}\u0000${t.name}`;
            if (!byName.has(key)) {
                byName.set(key, {
                    file: t.file,
                    nesting: t.nesting,
                    name: t.name,
                    kind: t.kind,
                    refs: t.refs,
                    results: new Map(),
                });
            }
            byName.get(key).results.set(job.id, t);
        }
    }
    const files = new Map();
    for (const row of byName.values()) {
        if (!files.has(row.file)) {
            files.set(row.file, []);
        }
        files.get(row.file).push(row);
    }

    const totals = {pass: 0, fail: 0, todo: 0, skip: 0};
    for (const job of jobs) {
        for (const k of Object.keys(totals)) {
            totals[k] += job.counts[k] || 0;
        }
    }
    const fuzzFindings = unexpectedFuzzFindings(report.fuzz);

    const h = [];
    h.push(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    );
    h.push(`<title>hm-radio-simulator test report ${esc(report.id)}</title><style>${CSS}</style></head><body>`);
    h.push(`<h1>hm-radio-simulator <span class="muted">test report</span></h1>`);
    h.push(
        `<p class="muted">${esc(report.generatedAt)}${report.repoSha ? ` · <a href="${esc(report.repoUrl)}" class="mono">${esc(report.repoSha.slice(0, 7))}</a>` : ''}${report.ref ? ` · ${esc(report.ref)}` : ''}${report.runUrl ? ` · <a href="${esc(report.runUrl)}">CI run ${esc(report.runId)}</a>` : ''} · <a href="${REPO}">repository</a> · <a href="report.json">report.json</a></p>`,
    );
    h.push(`<div class="cards">`);
    h.push(
        `<div class="card"><div class="big overall-${report.status}">${report.status === 'pass' ? 'green' : 'red'}</div><div class="label">overall</div></div>`,
    );
    h.push(
        `<div class="card"><div class="big pass">${totals.pass}</div><div class="label">passed (all jobs)</div></div>`,
    );
    h.push(`<div class="card"><div class="big fail">${totals.fail}</div><div class="label">failed</div></div>`);
    h.push(
        `<div class="card"><div class="big todo">${totals.todo}</div><div class="label">todo: known broken on that ref</div></div>`,
    );
    h.push(
        `<div class="card"><div class="big ${fuzzFindings ? 'todo' : 'pass'}">${fuzzFindings}</div><div class="label">new fuzz findings (expected ones on old refs not counted)</div></div>`,
    );
    h.push(`</div>`);

    // Jobs: name | commit | daemons | duration | pass | fail | todo | skip
    h.push(`<h2>Jobs</h2>`);
    h.push(
        table(
            [
                {label: 'OpenCCU-Base'},
                {label: 'commit', cls: 'c'},
                {label: 'daemons', cls: 's'},
                {label: 'duration', cls: 'd r'},
                {label: 'pass', cls: 'r'},
                {label: 'fail', cls: 'r'},
                {label: 'todo', cls: 'r'},
                {label: 'skip', cls: 'r'},
            ],
            jobs.map((job) => [
                `${esc(job.ref)}<span class="phone-only mono">${esc(short(job.baseCommit))}</span>${job.knownBroken.length ? `<div class="diag">known broken: ${esc(job.knownBroken.join(', '))}</div>` : ''}`,
                `<a class="mono" href="${BASE}/commit/${esc(job.baseCommit)}">${esc(short(job.baseCommit))}</a>`,
                esc(job.variant),
                esc(seconds(job.durationMs)),
                `<span class="pass">${job.counts.pass}</span>`,
                `<span class="fail">${job.counts.fail}</span>`,
                `<span class="todo">${job.counts.todo}</span>`,
                `<span class="skip">${job.counts.skip}</span>`,
            ]),
        ),
    );

    // Tests: name | kind | links | one result column per job
    h.push(
        `<h2>Tests</h2><p class="muted">One column per job. <span class="badge kind-regression">regression</span> pins an upstream fix and links to its pull request and commit; <span class="badge kind-known-bug">known bug</span> is a finding of this suite without an upstream fix (todo everywhere); <span class="badge kind-behaviour">behaviour</span> a measured daemon behaviour; <span class="badge kind-fuzz">fuzz</span> a seeded fuzzing test. A <span class="todo">todo</span> is a regression test on a ref that predates the fix.</p>`,
    );
    const testHead = [
        {label: 'test'},
        {label: 'kind', cls: 'k'},
        {label: 'links', cls: 'l'},
        ...jobs.map((job) => ({
            label: `${esc(job.ref)}<br><span class="muted">${esc(job.variant)}</span>`,
            cls: 'r',
            raw: true,
        })),
    ];
    for (const [file, rows] of files) {
        h.push(`<h3 class="mono">${esc(file || '?')}</h3>`);
        h.push(
            table(
                testHead,
                rows.map((row) => {
                    const first = [...row.results.values()][0];
                    const diags = new Set();
                    const errors = new Set();
                    for (const r of row.results.values()) {
                        for (const d of r.diagnostics || []) {
                            diags.add(d);
                        }
                        if (r.status === 'fail' && r.error) {
                            errors.add(r.error);
                        }
                    }
                    const kindBadge = `<span class="badge kind-${esc(row.kind)}">${esc(row.kind.replace('-', ' '))}</span>`;
                    const links = (first.refs || []).map((ref) => `<a href="${esc(ref.url)}">${esc(ref.label)}</a>`);
                    let name = `${row.nesting > 0 ? '<span class="sub"></span>' : ''}${esc(row.name)}`;
                    name += `<div class="phone-only">${kindBadge}${links.length ? ' ' + links.join(' · ') : ''}</div>`;
                    for (const e of errors) {
                        name += `<div class="err">${esc(e)}</div>`;
                    }
                    for (const d of diags) {
                        name += `<div class="diag">${esc(d)}</div>`;
                    }
                    const cells = [name, kindBadge, links.join('<br>')];
                    for (const job of jobs) {
                        const r = row.results.get(job.id);
                        if (!r) {
                            cells.push(`<span class="muted">-</span>`);
                        } else {
                            const title =
                                r.todo && typeof r.todo === 'string'
                                    ? r.todo
                                    : r.skip && typeof r.skip === 'string'
                                      ? r.skip
                                      : '';
                            cells.push(
                                `<span class="${r.status}" title="${esc(title)}">${esc(STATUS_MARK[r.status] || r.status)} ${esc(r.status)}</span><br><span class="muted">${esc(duration(r.durationMs))}</span>`,
                            );
                        }
                    }
                    return cells;
                }),
            ),
        );
    }

    // Fuzzing: name | commit | harness | time | executions | exec/s | findings
    if (report.fuzz.length) {
        h.push(`<h2>Fuzzing (libFuzzer)</h2>`);
        h.push(
            table(
                [
                    {label: 'OpenCCU-Base'},
                    {label: 'commit', cls: 'c'},
                    {label: 'harness', cls: 'k'},
                    {label: 'time', cls: 'r'},
                    {label: 'executions', cls: 'r'},
                    {label: 'exec/s', cls: 'r'},
                    {label: 'findings', cls: 'r'},
                ],
                report.fuzz.flatMap((run) =>
                    run.harnesses.map((hz) => [
                        esc(run.ref),
                        `<a class="mono" href="${BASE}/commit/${esc(run.baseCommit)}">${esc(short(run.baseCommit))}</a>`,
                        `<span class="mono">${esc(hz.name)}</span>`,
                        `${esc(String(hz.seconds))} s`,
                        esc(String(hz.execs ?? '?')),
                        esc(String(hz.execPerSec ?? '?')),
                        hz.findings.length
                            ? `<span class="${run.expected ? 'todo' : 'fail'}" title="${esc(hz.findings.map((f) => f.type).join(', '))}">${hz.findings.length}${run.expected ? ' <span class="muted">(expected)</span>' : ''}</span>`
                            : `<span class="pass">0</span>`,
                    ]),
                ),
            ),
        );
    }

    // History: run | commit | overall | pass | fail | todo | fuzz findings
    if (history.length) {
        h.push(`<h2>History</h2>`);
        h.push(
            table(
                [
                    {label: 'run'},
                    {label: 'commit', cls: 'c'},
                    {label: 'overall', cls: 's r'},
                    {label: 'pass', cls: 'r'},
                    {label: 'fail', cls: 'r'},
                    {label: 'todo', cls: 'r'},
                    {label: 'fuzz findings', cls: 'r'},
                ],
                history.map((entry) => [
                    `<a href="runs/${esc(entry.id)}/">${esc(entry.generatedAt)}</a>${entry.runUrl ? ` <a class="muted" href="${esc(entry.runUrl)}">(CI)</a>` : ''}`,
                    `<a class="mono" href="${REPO}/commit/${esc(entry.repoSha)}">${esc(short(entry.repoSha))}</a>`,
                    `<span class="${esc(entry.status)}">${esc(entry.status === 'pass' ? 'green' : 'red')}</span>`,
                    `<span class="pass">${entry.pass}</span>`,
                    `<span class="fail">${entry.fail}</span>`,
                    `<span class="todo">${entry.todo}</span>`,
                    `<span class="${entry.fuzzFindings ? 'todo' : 'pass'}">${entry.fuzzFindings}</span>`,
                ]),
            ),
        );
    }
    h.push(
        `<footer>hm-radio-simulator - a simulated Homematic radio module and a test suite for the CCU's radio daemons of <a href="${BASE}">OpenCCU-Base</a>. MIT. The daemons under test are built from the OpenCCU-Base commits linked above.</footer>`,
    );
    h.push(`</body></html>`);
    return h.join('\n') + '\n';
}

function duration(ms) {
    if (ms === null || ms === undefined) {
        return '';
    }
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function esc(text) {
    return String(text ?? '').replace(
        /[&<>"']/g,
        (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
    );
}

// ---------------------------------------------------------------------------------------------------------------
// history and site

export function historyEntry(report) {
    const totals = {pass: 0, fail: 0, todo: 0};
    for (const job of report.jobs) {
        totals.pass += job.counts.pass || 0;
        totals.fail += job.counts.fail || 0;
        totals.todo += job.counts.todo || 0;
    }
    return {
        id: report.id,
        generatedAt: report.generatedAt,
        repoSha: report.repoSha,
        runId: report.runId,
        runUrl: report.runUrl,
        status: report.status,
        ...totals,
        fuzzFindings: unexpectedFuzzFindings(report.fuzz),
    };
}

/**
 * Writes the site: the latest report at the root, every kept run under runs/<id>/, history.json.
 * @param {object} report
 * @param {{out: string, previous?: string, keep?: number}} options
 */
export function writeSite(report, {out, previous, keep = 20}) {
    let history = [];
    if (previous && fs.existsSync(path.join(previous, 'history.json'))) {
        try {
            history = readJson(path.join(previous, 'history.json')).filter((e) => e.id !== report.id);
        } catch {
            history = [];
        }
    }
    history.unshift(historyEntry(report));
    history = history.slice(0, keep);

    fs.mkdirSync(out, {recursive: true});
    for (const entry of history.slice(1)) {
        const src = previous ? path.join(previous, 'runs', entry.id) : null;
        const dst = path.join(out, 'runs', entry.id);
        if (src && fs.existsSync(src) && path.resolve(src) !== path.resolve(dst)) {
            fs.cpSync(src, dst, {recursive: true});
        }
    }
    const html = renderHtml(report, history);
    const runDir = path.join(out, 'runs', report.id);
    fs.mkdirSync(runDir, {recursive: true});
    fs.writeFileSync(path.join(runDir, 'index.html'), html);
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 1) + '\n');
    fs.writeFileSync(path.join(out, 'index.html'), html);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1) + '\n');
    fs.writeFileSync(path.join(out, 'summary.md'), renderSummaryMarkdown(report) + '\n');
    fs.writeFileSync(path.join(out, 'history.json'), JSON.stringify(history, null, 1) + '\n');
    fs.writeFileSync(path.join(out, '.nojekyll'), '');
    return history;
}

// ---------------------------------------------------------------------------------------------------------------
// command line

function parseArgs(argv) {
    const options = {roots: []};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            options[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
        } else {
            options.roots.push(a);
        }
    }
    return options;
}

function main(argv) {
    const [command, ...rest] = argv;
    const options = parseArgs(rest);
    if (command === 'summary') {
        const results = collectResults(options.roots);
        const report = buildReport(results, {
            repoSha: options.repoSha,
            runId: options.runId,
            runUrl: options.runUrl,
            ref: options.ref,
        });
        process.stdout.write(renderSummaryMarkdown(report) + '\n');
        return 0;
    }
    if (command === 'collect') {
        if (!options.out) {
            console.error('collect: --out <site dir> is required');
            return 2;
        }
        const results = collectResults(options.roots);
        if (results.jobs.length === 0 && results.fuzz.length === 0) {
            console.error(`collect: no results found below ${options.roots.join(', ') || '(nothing given)'}`);
            return 1;
        }
        const report = buildReport(results, {
            repoSha: options.repoSha,
            runId: options.runId,
            runUrl: options.runUrl,
            ref: options.ref,
        });
        const history = writeSite(report, {
            out: options.out,
            previous: options.previous,
            keep: Number(options.keep || 20),
        });
        console.log(
            `report ${report.id}: ${report.status}, ${results.jobs.length} jobs, ${results.fuzz.length} fuzz runs, ${history.length} runs in the history -> ${options.out}`,
        );
        return 0;
    }
    console.error(
        'usage: report.mjs collect --out <dir> [--previous <dir>] [--repo-sha <sha>] [--run-id <id>] [--run-url <url>] <results>...\n       report.mjs summary <results>...',
    );
    return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
