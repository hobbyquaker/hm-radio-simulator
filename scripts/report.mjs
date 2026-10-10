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
        lines.push('| OpenCCU-Base | daemons | pass | fail | todo (known) | skip | duration |');
        lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
        for (const job of report.jobs) {
            lines.push(
                `| ${job.ref} ([${short(job.baseCommit)}](${BASE}/commit/${job.baseCommit})) | ${job.variant} | ${job.counts.pass} | ${job.counts.fail} | ${job.counts.todo} | ${job.counts.skip} | ${seconds(job.durationMs)} |`,
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
        lines.push('| --- | --- | ---: | ---: | --- |');
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
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: .85rem; white-space: nowrap; }
td.num { text-align: right; white-space: nowrap; } td.st { text-align: center; white-space: nowrap; }
.badge { display: inline-block; padding: 0 .5em; border-radius: 999px; font-size: .78em; font-weight: 600; line-height: 1.6;
  border: 1px solid currentColor; }
.pass { color: var(--pass); } .fail { color: var(--fail); } .todo { color: var(--todo); } .skip { color: var(--skip); }
.kind-regression { color: var(--link); } .kind-known-bug { color: var(--todo); } .kind-behaviour { color: var(--muted); }
.kind-fuzz { color: var(--pass); }
.sub { padding-left: 1.5rem; color: var(--muted); }
.diag { color: var(--muted); font-size: .85em; } .err { color: var(--fail); font-size: .85em; }
.overall-pass { color: var(--pass); } .overall-fail { color: var(--fail); }
footer { margin-top: 3rem; color: var(--muted); font-size: .85rem; }
`;

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

    h.push(
        `<h2>Jobs</h2><table><tr><th>OpenCCU-Base</th><th>commit</th><th>daemons</th><th>pass</th><th>fail</th><th>todo</th><th>skip</th><th>duration</th><th>known broken</th></tr>`,
    );
    for (const job of jobs) {
        h.push(
            `<tr><td>${esc(job.ref)}</td><td><a class="mono" href="${BASE}/commit/${esc(job.baseCommit)}">${esc(short(job.baseCommit))}</a></td><td>${esc(job.variant)}</td><td class="num pass">${job.counts.pass}</td><td class="num fail">${job.counts.fail}</td><td class="num todo">${job.counts.todo}</td><td class="num skip">${job.counts.skip}</td><td class="num">${esc(seconds(job.durationMs))}</td><td class="muted">${esc(job.knownBroken.join(', ') || '-')}</td></tr>`,
        );
    }
    h.push(`</table>`);

    h.push(
        `<h2>Tests</h2><p class="muted">One column per job. <span class="badge kind-regression">regression</span> pins an upstream fix and links to its pull request and commit; <span class="badge kind-known-bug">known bug</span> is a finding of this suite without an upstream fix (todo everywhere); <span class="badge kind-behaviour">behaviour</span> a measured daemon behaviour; <span class="badge kind-fuzz">fuzz</span> a seeded fuzzing test. A <span class="todo">todo</span> is a regression test on a ref that predates the fix.</p>`,
    );
    for (const [file, rows] of files) {
        h.push(`<h3 class="mono">${esc(file || '?')}</h3><table><tr><th>test</th><th>kind</th>`);
        for (const job of jobs) {
            h.push(`<th>${esc(job.ref)}<br><span class="muted">${esc(job.variant)}</span></th>`);
        }
        h.push(`<th>links</th></tr>`);
        for (const row of rows) {
            const first = [...row.results.values()][0];
            h.push(`<tr><td class="${row.nesting > 0 ? 'sub' : ''}">${esc(row.name)}`);
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
            for (const e of errors) {
                h.push(`<div class="err">${esc(e)}</div>`);
            }
            for (const d of diags) {
                h.push(`<div class="diag">${esc(d)}</div>`);
            }
            h.push(`</td><td><span class="badge kind-${esc(row.kind)}">${esc(row.kind.replace('-', ' '))}</span></td>`);
            for (const job of jobs) {
                const r = row.results.get(job.id);
                if (!r) {
                    h.push(`<td class="st muted">-</td>`);
                } else {
                    h.push(
                        `<td class="st ${r.status}" title="${esc(r.todo && typeof r.todo === 'string' ? r.todo : r.skip && typeof r.skip === 'string' ? r.skip : '')}">${esc(STATUS_MARK[r.status] || r.status)} ${esc(r.status)}<br><span class="muted">${esc(duration(r.durationMs))}</span></td>`,
                    );
                }
            }
            h.push(
                `<td>${(first.refs || []).map((ref) => `<a href="${esc(ref.url)}">${esc(ref.label)}</a>`).join('<br>')}</td></tr>`,
            );
        }
        h.push(`</table>`);
    }

    if (report.fuzz.length) {
        h.push(
            `<h2>Fuzzing (libFuzzer)</h2><table><tr><th>OpenCCU-Base</th><th>commit</th><th>harness</th><th>time</th><th>executions</th><th>exec/s</th><th>findings</th></tr>`,
        );
        for (const run of report.fuzz) {
            for (const hz of run.harnesses) {
                h.push(
                    `<tr><td>${esc(run.ref)}</td><td><a class="mono" href="${BASE}/commit/${esc(run.baseCommit)}">${esc(short(run.baseCommit))}</a></td><td class="mono">${esc(hz.name)}</td><td class="num">${esc(String(hz.seconds))} s</td><td class="num">${esc(String(hz.execs ?? '?'))}</td><td class="num">${esc(String(hz.execPerSec ?? '?'))}</td><td class="${hz.findings.length ? (run.expected ? 'todo' : 'fail') : 'pass'}">${hz.findings.length ? esc(hz.findings.map((f) => f.type).join(', ')) + (run.expected ? ' <span class="muted">(expected on this ref)</span>' : '') : 'none'}</td></tr>`,
                );
            }
        }
        h.push(`</table>`);
    }

    if (history.length) {
        h.push(
            `<h2>History</h2><table><tr><th>run</th><th>commit</th><th>overall</th><th>pass</th><th>fail</th><th>todo</th><th>fuzz findings</th></tr>`,
        );
        for (const entry of history) {
            h.push(
                `<tr><td><a href="runs/${esc(entry.id)}/">${esc(entry.generatedAt)}</a>${entry.runUrl ? ` <a class="muted" href="${esc(entry.runUrl)}">(CI)</a>` : ''}</td><td><a class="mono" href="${REPO}/commit/${esc(entry.repoSha)}">${esc(short(entry.repoSha))}</a></td><td class="${entry.status}">${esc(entry.status === 'pass' ? 'green' : 'red')}</td><td class="num pass">${entry.pass}</td><td class="num fail">${entry.fail}</td><td class="num todo">${entry.todo}</td><td class="num">${entry.fuzzFindings}</td></tr>`,
            );
        }
        h.push(`</table>`);
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
        if (src && fs.existsSync(src)) {
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
