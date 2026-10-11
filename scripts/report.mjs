#!/usr/bin/env node
/**
 * The test report: merges the results of the daemon suites (results/<variant>/tests.json + meta.json, written by the
 * JSON reporter and the entrypoint) and the fuzz runs (results/fuzz/summary.json) of one CI run into
 *
 *   report.json   the run as data
 *   summary.md    a Markdown overview for $GITHUB_STEP_SUMMARY
 *   index.html    a static page (inline CSS, dark mode, no JavaScript) for GitHub Pages
 *   history.json  the last runs, with the new one first
 *   sweep/<ref>.json  the sweep records of each ref's release job; the next run diffs main against sweep/main.json
 *   runs/<id>/    the page and data of every run kept in the history
 *
 * Usage:
 *   report.mjs collect --out <site dir> [--previous <dir with the published site>] [--repo-sha <sha>]
 *                      [--run-id <id>] [--run-url <url>] [--ref <git ref>] [--trigger <text>] [--keep 20]
 *                      <results dir>...
 *   report.mjs summary <results dir>...        print the Markdown overview of these results only
 *
 * `--proof <proof.json>` (scripts/prove.mjs collect): the proof of the regression tests. report.json then carries it as
 * `proof`, it is published as proof.json, and every test the proof ran gets a field
 * `proof: {status: 'proven'|'not-proven'|'inconclusive'|'no-build'|'incomplete', fix, parent, merge, date}` (prove.mjs proofForTest).
 *   report.mjs check <results dir>...          fail when a test has no description (test/descriptions.js)
 *
 * The test names carry their upstream references (see test/metadata.js), so a regression test links to the pull
 * request and commit that fixed the bug, a known finding to its issue or, until one exists, to the README.
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {describeTest} from '../test/metadata.js';
import {describe} from '../test/descriptions.js';
import {groupByRef, combine, refCounts, VARIANT_CHIP} from './combine.mjs';
import {trendOf, renderTrendPanel, TREND_CSS, daemonOf} from './trend.mjs';
import {renderFilterBar, FILTER_SCRIPT, FILTER_CSS} from './filter.mjs';
import {readSweep, buildDifferential, DIFF_LIST_LIMIT} from './differential.mjs';
import {compareRefs} from './refs.mjs';
import {proofForTest} from './prove.mjs';

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
                const job = makeJob(meta, tests);
                const loadFile = path.join(dir, 'load.json');
                if (fs.existsSync(loadFile)) {
                    job.load = readJson(loadFile);
                }
                const sweep = readSweep(dir);
                if (sweep) {
                    // the sweep records, for the differential (not part of report.json: they are large)
                    Object.defineProperty(job, 'sweep', {value: sweep, enumerable: false});
                }
                const summaryFile = path.join(dir, 'coverage-summary.json');
                if (fs.existsSync(summaryFile)) {
                    // the coverage variant: the per-component summary, and the data files to publish next to the page
                    job.coverage = readJson(summaryFile);
                    job.coverageFiles = ['coverage.info', 'coverage.json']
                        .map((f) => path.join(dir, f))
                        .filter((f) => fs.existsSync(f));
                }
                jobs.push(job);
            } else if (entry.name === 'fuzz-summary.json') {
                fuzz.push(readJson(full));
            }
        }
    };
    for (const root of roots) {
        walk(root);
    }
    // oldest tag -> newer tag -> main; per ref release, asan, coverage
    const variantOrder = (v) => ['release', 'asan', 'coverage'].indexOf(v) + 1 || 9;
    jobs.sort((a, b) => compareRefs(a.ref, b.ref) || variantOrder(a.variant) - variantOrder(b.variant));
    fuzz.sort((a, b) => compareRefs(a.ref, b.ref));
    return {jobs, fuzz};
}

function makeJob(meta, results) {
    const tests = (results.tests || []).map((t) => {
        const {kind, refs} = describeTest(t.name, t);
        return {...t, kind, refs, description: describe(t.file, t.name)};
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
 * @param {{repoSha?: string, runId?: string, runUrl?: string, ref?: string, generatedAt?: string,
 *   trigger?: string, previousMain?: object|null}} run `previousMain`: the main sweep records the previous report
 *   published (for the differential against the previously tested commit)
 */
export function buildReport(results, run = {}) {
    const generatedAt = run.generatedAt || new Date().toISOString();
    const sha = run.repoSha || '';
    const id = `${generatedAt.slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}${sha ? `-${sha.slice(0, 7)}` : ''}`;
    const status = overallStatus(results);
    if (run.proof) {
        for (const job of results.jobs) {
            for (const t of job.tests) {
                const proof = proofForTest(t, run.proof);
                if (proof) {
                    t.proof = proof;
                }
            }
        }
    }
    return {
        id,
        generatedAt,
        repoSha: sha,
        repoUrl: sha ? `${REPO}/commit/${sha}` : REPO,
        ref: run.ref || '',
        trigger: run.trigger || '',
        runId: run.runId || '',
        runUrl: run.runUrl || '',
        status,
        jobs: results.jobs,
        fuzz: results.fuzz,
        listMethods: listMethodsRows(results.jobs),
        load: loadRows(results.jobs),
        differential: buildDifferential(results.jobs, run.previousMain || null).map((s) => ({
            ...s,
            diff: {...s.diff, items: s.diff.items.slice(0, DIFF_LIST_LIMIT)},
        })),
        ...(run.proof ? {proof: run.proof} : {}),
    };
}

/**
 * The listMethods truth test's summaries (test/daemon/listmethods-truth.test.js) from the release jobs' sweep records.
 * @returns {Array<{ref: string, daemon: string, protocol: string, listed: number, callable: number, unlistedCallable: string[], helpGaps: string[]}>}
 */
export function listMethodsRows(jobs) {
    const rows = [];
    for (const job of jobs.filter((j) => j.variant === 'release' && j.sweep)) {
        for (const [name, record] of Object.entries(job.sweep)) {
            const m = /^(.+)-listmethods-(binrpc|xmlrpc)$/.exec(name);
            if (m && record && record.summary) {
                rows.push({
                    ref: job.ref,
                    daemon: m[1],
                    protocol: m[2],
                    listed: record.summary.listed,
                    callable: record.summary.callable,
                    unlistedCallable: record.summary.unlistedCallable || [],
                    helpGaps: record.summary.helpGaps || [],
                });
            }
        }
    }
    return rows.sort(
        (a, b) =>
            a.daemon.localeCompare(b.daemon) || a.protocol.localeCompare(b.protocol) || a.ref.localeCompare(b.ref),
    );
}

/**
 * The load test's numbers (test/daemon/rfd-load.test.js, results/<variant>/load.json) of the release jobs.
 * @returns {Array<{ref: string, run: string, offered: number|null, achieved: number|null, p95: number|null, events: string, note: string}>}
 */
export function loadRows(jobs) {
    const rows = [];
    for (const job of jobs.filter((j) => j.variant === 'release' && j.load)) {
        const l = job.load;
        if (l.burst) {
            rows.push({
                ref: job.ref,
                run: `burst (air max ${l.burst.airMaxPerSecond}/s, computed)`,
                offered: l.burst.offeredPerSecond,
                achieved: l.burst.achievedPerSecond,
                p95: l.burst.latencyMs?.p95 ?? null,
                events: `${l.burst.pressEvents}/${l.burst.presses}`,
                note: `${l.burst.calls} calls, ${l.burst.failed} failed, ${l.burst.levelSetFrames} on air`,
            });
        }
        if (l.sustained) {
            rows.push({
                ref: job.ref,
                run: `sustained (window ${l.sustained.windowMs / 1000} s)`,
                offered: null,
                achieved: null,
                p95: null,
                events: '-',
                note: `meter ${l.sustained.meterPercent} %, rfd ${l.sustained.rfdDutyCycle} %, RSS ${l.sustained.rssKb.join(' -> ')} kB`,
            });
        }
        if (l.overload) {
            rows.push({
                ref: job.ref,
                run: 'overload (200 %, duty cycle exceeded)',
                offered: l.overload.offeredPerSecond,
                achieved: null,
                p95: l.overload.probeLatencyMs?.p95 ?? null,
                events: `${l.overload.pressEvents}/${l.overload.presses}`,
                note: `${l.overload.answeredOk} ok, ${l.overload.faults} faults, ${l.overload.refusedByModule} refused by the module, recovered ${l.overload.recovered}`,
            });
        }
    }
    return rows;
}

/** The tests (file and name, once each) without a description in test/descriptions.js. */
export function missingDescriptions(results) {
    const seen = new Map();
    for (const job of results.jobs) {
        for (const t of job.tests) {
            if (!t.description) {
                seen.set(`${t.file}\u0000${t.name}`, {file: t.file, name: t.name});
            }
        }
    }
    return [...seen.values()];
}

/** Fuzz findings that are not expected on that ref (an old tag has known ones). */
export function unexpectedFuzzFindings(fuzz) {
    return fuzz
        .filter((f) => !f.expected)
        .reduce((n, f) => n + f.harnesses.filter((h) => !h.known).reduce((m, h) => m + h.findings.length, 0), 0);
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
        `${report.status === 'pass' ? '✅' : '❌'} ${report.status === 'pass' ? 'green' : 'red'} - ${report.generatedAt}${report.repoSha ? ` - [${report.repoSha.slice(0, 7)}](${report.repoUrl})` : ''}${report.trigger ? ` - triggered by ${escapeMd(report.trigger)}` : ''}`,
    );
    lines.push('');
    if (report.jobs.length) {
        // one row per ref: the variants with their durations, the combined counts (a test counts with its worst result)
        const refs = groupByRef(report.jobs);
        const rows = testRows(report.jobs);
        lines.push('| OpenCCU-Base | variants | pass | fail | todo (known) | skip |');
        lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
        for (const {ref, counts: c} of refCounts(rows, refs)) {
            lines.push(
                `| ${ref.ref} ([${short(ref.baseCommit)}](${BASE}/commit/${ref.baseCommit})) | ${ref.jobs.map((j) => `${j.variant} ${seconds(j.durationMs)}`).join(' · ')} | ${c.pass} | ${c.fail} | ${c.todo} | ${c.skip} |`,
            );
        }
        lines.push('');
        const where = (row, status) =>
            refs
                .map((ref) => {
                    const c = combine(row.results, ref);
                    const variants = c ? c.variants.filter((v) => v.status === status).map((v) => v.variant) : [];
                    return variants.length ? `${ref.ref}: ${variants.join(', ')}` : null;
                })
                .filter(Boolean)
                .join('; ');
        const failing = rows.filter((row) => [...row.results.values()].some((t) => t.status === 'fail'));
        if (failing.length) {
            lines.push('### Failures');
            lines.push('');
            for (const row of failing) {
                const error = [...row.results.values()].find((t) => t.status === 'fail' && t.error);
                lines.push(
                    `- ❌ **${escapeMd(row.name)}** (${where(row, 'fail')})${error ? `: ${escapeMd(error.error)}` : ''}`,
                );
            }
            lines.push('');
        }
        const todo = rows.filter((row) => [...row.results.values()].some((t) => t.status === 'todo'));
        if (todo.length) {
            lines.push('### Known broken on these refs (run as todo)');
            lines.push('');
            for (const row of todo) {
                const first = [...row.results.values()][0];
                lines.push(`- ⚠️ ${escapeMd(row.name)} - ${where(row, 'todo')}${linksMd(first.refs)}`);
            }
            lines.push('');
        }
        const differing = rows.filter((row) => refs.some((ref) => (combine(row.results, ref) || {}).differs));
        if (differing.length) {
            lines.push('### Where the variants differ');
            lines.push('');
            for (const row of differing) {
                const parts = refs
                    .map((ref) => combine(row.results, ref))
                    .map((c, i) =>
                        c && c.differs
                            ? `${refs[i].ref}: ${c.variants.map((v) => `${v.variant} ${STATUS_MARK[v.status] || v.status}`).join(' ')}`
                            : null,
                    )
                    .filter(Boolean);
                lines.push(`- ${escapeMd(row.name)} - ${parts.join('; ')}`);
            }
            lines.push('');
        }
    }
    const covered = report.jobs.filter((j) => j.coverage);
    if (covered.length) {
        lines.push('### Coverage (clang source-based, the coverage variant)');
        lines.push('');
        lines.push('| OpenCCU-Base | component | lines | functions | branches |');
        lines.push('| --- | --- | ---: | ---: | ---: |');
        for (const job of covered) {
            for (const c of job.coverage.components.filter((c) => c.kind === 'daemon' || c.linesTotal > 0)) {
                lines.push(
                    `| ${job.ref} | ${c.component}${c.kind === 'library' ? ' (library)' : ''} | ${pctText(c.lines)} (${c.linesHit}/${c.linesTotal}) | ${pctText(c.functions)} | ${pctText(c.branches)} |`,
                );
            }
        }
        lines.push('');
    }
    if ((report.load || []).length) {
        lines.push('### Load (airtime computed, not measured)');
        lines.push('');
        lines.push('| run | OpenCCU-Base | offered/s | achieved/s | p95 latency | events delivered | notes |');
        lines.push('| --- | --- | ---: | ---: | ---: | ---: | --- |');
        for (const r of report.load) {
            lines.push(
                `| ${r.run} | ${r.ref} | ${r.offered ?? '-'} | ${r.achieved ?? '-'} | ${r.p95 === null ? '-' : `${r.p95} ms`} | ${r.events} | ${escapeMd(r.note)} |`,
            );
        }
        lines.push('');
    }
    if ((report.listMethods || []).length) {
        lines.push('### listMethods tells the truth');
        lines.push('');
        lines.push(
            '| daemon | callbacks over | OpenCCU-Base | listed | callable | unlisted but callable | methodHelp gaps |',
        );
        lines.push('| --- | --- | --- | ---: | ---: | --- | --- |');
        for (const r of report.listMethods) {
            lines.push(
                `| ${r.daemon} | ${r.protocol} | ${r.ref} | ${r.listed} | ${r.callable} | ${r.unlistedCallable.join(', ') || 'none'} | ${r.helpGaps.join(', ') || 'none'} |`,
            );
        }
        lines.push('');
    }
    for (const section of report.differential || []) {
        const d = section.diff;
        lines.push(`### Differential: ${escapeMd(section.title)}`);
        lines.push('');
        lines.push(
            `OpenCCU-Base [${short(section.from.baseCommit)}](${BASE}/commit/${section.from.baseCommit}) → [${short(section.to.baseCommit)}](${BASE}/commit/${section.to.baseCommit}): ${d.changed} changed, ${d.added} added, ${d.removed} removed, ${d.equal} equal answers of the RPC and device-type sweeps${d.ignored ? ` (${d.ignored} ignored by design)` : ''}.`,
        );
        if (d.items.length) {
            lines.push('');
            lines.push('<details><summary>the differences</summary>');
            lines.push('');
            for (const item of d.items) {
                lines.push(
                    `- \`${escapeMd(item.sweep)}\` ${escapeMd(item.key)}: ${item.from === null ? '(new)' : escapeMd(item.from)} → ${item.to === null ? '(gone)' : escapeMd(item.to)}`,
                );
            }
            lines.push('');
            lines.push('</details>');
        }
        lines.push('');
    }
    if (report.fuzz.length) {
        lines.push('### Fuzzing');
        lines.push('');
        lines.push('| OpenCCU-Base | harness | time | executions | findings |');
        lines.push('| --- | --- | ---: | ---: | ---: |');
        for (const run of report.fuzz) {
            for (const h of run.harnesses) {
                lines.push(
                    `| ${run.ref} ([${short(run.baseCommit)}](${BASE}/commit/${run.baseCommit})) | ${h.name} | ${h.seconds} s | ${h.execs ?? '?'} | ${h.findings.length ? h.findings.map((f) => f.type).join(', ') + (h.known ? ` (known finding ${h.known})` : run.expected ? ' (expected on this ref)' : '') : 'none'} |`,
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

function pctText(value) {
    return value === null || value === undefined ? '-' : `${value.toFixed(1)} %`;
}

function short(sha) {
    return sha ? String(sha).slice(0, 7) : '?';
}

function seconds(ms) {
    return ms ? `${(ms / 1000).toFixed(0)} s` : '-';
}

// ---------------------------------------------------------------------------------------------------------------
// HTML

const CSS_BASE = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d9d9de; --card: #f5f5f7;
  --pass: #2e7d32; --fail: #c62828; --todo: #b26a00; --skip: #607d8b; --link: #0b57d0; }
@media (prefers-color-scheme: dark) { :root { --bg: #16161a; --fg: #e7e7ea; --muted: #9a9aa3; --line: #34343c;
  --card: #1f1f26; --pass: #66bb6a; --fail: #ef5350; --todo: #ffb74d; --skip: #90a4ae; --link: #8ab4f8; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 1.5rem; font: 15px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg); color: var(--fg); margin: 0 auto; }
/* the page is as wide as the window: a table with every ref and variant side by side may need a big screen; on a
   smaller one it scrolls sideways in its own box (every table has a min-width: the name column plus its fixed columns) */
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; } p, h1, h2, h3, .cards, ul.diff, footer { max-width: 1400px; }
a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; } h2 { font-size: 1.2rem; margin: 2rem 0 .75rem; }
h3 { font-size: 1rem; margin: 1.5rem 0 .5rem; color: var(--muted); font-weight: 600; }
.muted { color: var(--muted); } .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
.cards { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1rem 0; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: .75rem 1rem; min-width: 11rem; }
.card .big { font-size: 1.5rem; font-weight: 600; } .card .label { color: var(--muted); font-size: .85rem; }
/* every table: the name column takes the rest, the fixed columns share one width scheme, the four result columns at
   the right edge are --w-result wide and right-aligned in every table */
:root { --w-result: 6.5rem; --w-commit: 5.5rem; --w-small: 6rem; --w-kind: 7.5rem; --w-links: 11rem; --w-name: 22rem;
  --w-variants: 15rem; }
.phone-only { display: none; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; table-layout: fixed; }
col.r { width: var(--w-result); } col.c { width: var(--w-commit); } col.s { width: var(--w-small); }
col.k { width: var(--w-kind); } col.l { width: var(--w-links); } col.d { width: var(--w-small); }
col.v { width: var(--w-variants); }
/* one line per row at load: the name is the summary of a collapsible, cut with an ellipsis; open it for the rest */
details.row > summary { display: block; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  list-style: none; }
details.row > summary::-webkit-details-marker { display: none; }
details.row > summary::before { content: '\\25B8'; display: inline-block; width: 1em; color: var(--muted); }
details.row[open] > summary::before { content: '\\25BE'; }
details.row[open] > summary { white-space: normal; }
details.row > :not(summary) { margin-left: 1em; }
p.what { margin: .3rem 0 .4rem; }
.chip { display: inline-block; min-width: 1.3em; padding: 0 .35em; border-radius: 4px; border: 1px solid currentColor;
  font-size: .72em; font-weight: 700; line-height: 1.5; text-align: center; vertical-align: 1px; color: var(--muted); }
.chip.fail { color: var(--fail); } .chip.todo { color: var(--todo); } .chip.skip { color: var(--skip); }
.variants { font-size: .85em; color: var(--muted); white-space: nowrap; } .vd { margin-right: .5em; }
ul.plain { list-style: none; padding: 0; margin: .3rem 0; } td.v { white-space: nowrap; }
/* the kind and links cells stay on one line too (the full links are in the row's collapsible on a phone) */
td.k, td.l { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.proof { font-size: .75em; font-weight: 600; white-space: nowrap; } .proof.proven { color: var(--pass); }
.proof.not-proven { color: var(--fail); } .proof.inconclusive { color: var(--todo); } .proof.no-build { color: var(--muted); }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top;
  overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 600; font-size: .85rem; }
th.r, td.r { text-align: right; font-variant-numeric: tabular-nums; padding-left: .9rem; } td.r { white-space: nowrap; }
td.name { overflow-wrap: anywhere; }
.badge { display: inline-block; padding: 0 .5em; border-radius: 999px; font-size: .78em; font-weight: 600; line-height: 1.6;
  border: 1px solid currentColor; }
.pass { color: var(--pass); } .fail { color: var(--fail); } .todo { color: var(--todo); } .skip { color: var(--skip); }
.kind-regression { color: var(--link); } .kind-known-bug { color: var(--todo); } .kind-behaviour { color: var(--muted); }
.kind-fuzz { color: var(--pass); }
.sub { padding-left: 1.5rem; color: var(--muted); }
.diag { color: var(--muted); font-size: .85em; } .err { color: var(--fail); font-size: .85em; }
.overall-pass { color: var(--pass); } .overall-fail { color: var(--fail); }
ul.diff { padding-left: 1.2rem; overflow-wrap: anywhere; } ul.diff li { margin: .2rem 0; }
footer { margin-top: 3rem; color: var(--muted); font-size: .85rem; }
/* phone: the commit, kind, links and duration columns shrink to a pixel (a zero width would count as auto) (their content moves under the name; the
   cells stay in the fixed layout so nothing shifts into the next <col>), the result columns keep one fixed width,
   the name wraps in the rest */
@media (max-width: 760px) { :root { --w-result: 3rem; --w-small: 3.6rem; --w-commit: 1px; --w-kind: 1px; --w-links: 1px;
    --w-variants: 1px; --w-name: 11rem; }
  body { padding: .75rem; font-size: 13px; }
  th, td { padding: .35rem .3rem; } th.r, td.r { padding-left: .3rem; }
  col.c, col.k, col.l, col.d, col.v { width: 1px; }
  th.c, th.k, th.l, th.d, th.v, td.c, td.k, td.l, td.d, td.v { padding: 0; border: 0; overflow: hidden; visibility: hidden;
    font-size: 0; line-height: 0; }
  td.r { white-space: nowrap; } .word { display: none; }
  .phone-only { display: block; margin-top: .2rem; } summary .phone-only { display: inline; } }
`;
const CSS = CSS_BASE + TREND_CSS + FILTER_CSS;

/**
 * A table with a <colgroup>: the first column takes the remaining width, the others are fixed by their class
 * (`c` commit, `s` small, `d` duration, `k` kind, `l` links, `r` result - the result columns share one width and are
 * right-aligned; at phone width c, k, l and d leave the table).
 * @param {Array<{label: string, cls?: string, raw?: boolean}>} head
 * @param {string[][]} rows cells as HTML
 */
function table(head, rows) {
    const cols = head.map((c) => {
        const cls = (c.cls || '').split(' ').find((x) => ['r', 'c', 's', 'k', 'l', 'd', 'v'].includes(x));
        return cls ? `<col class="${cls}">` : '<col>';
    });
    const ths = head.map((c) => `<th class="${esc(c.cls || '')}">${c.raw ? c.label : esc(c.label)}</th>`);
    // a row is its cells, or {cells, attrs} with attributes for the <tr> (the filter's data-*)
    const trs = rows.map((row) => {
        const cells = Array.isArray(row) ? row : row.cells;
        const attrs = Array.isArray(row)
            ? ''
            : Object.entries(row.attrs || {})
                  .map(([k, v]) => ` ${k}="${esc(v)}"`)
                  .join('');
        return `<tr${attrs}>${cells.map((cell, i) => `<td class="${i === 0 ? 'name' : esc(head[i].cls || '')}">${cell}</td>`).join('')}</tr>`;
    });
    // the table never squeezes below its columns' widths; the .scroll box around it scrolls instead
    const widths = {
        r: '--w-result',
        c: '--w-commit',
        s: '--w-small',
        k: '--w-kind',
        l: '--w-links',
        d: '--w-small',
        v: '--w-variants',
    };
    const fixed = head
        .map((c) => (c.cls || '').split(' ').find((x) => x in widths))
        .filter(Boolean)
        .map((x) => `var(${widths[x]})`);
    const min = `calc(var(--w-name) + ${fixed.length ? fixed.join(' + ') : '0px'})`;
    return `<div class="scroll"><table style="min-width: ${min}"><colgroup>${cols.join('')}</colgroup><thead><tr>${ths.join('')}</tr></thead><tbody>\n${trs.join('\n')}\n</tbody></table></div>`;
}

const PROOF = {
    proven: {mark: '✓', label: 'proven', title: "fails on the fix's parent commit, passes on its merge commit"},
    'not-proven': {
        mark: '✗',
        label: 'not proven',
        title: 'did not fail on the parent commit, or did not pass on the merge',
    },
    inconclusive: {mark: '?', label: 'inconclusive', title: 'the proof runs disagreed'},
    'no-build': {mark: '–', label: 'no build', title: 'the parent or the merge commit did not build'},
};

/** A regression test's proof (task 30): a small mark for the kind cell. */
export function proofMark(proof) {
    const p = PROOF[proof.status] || {mark: '?', label: proof.status, title: ''};
    return `<span class="proof ${esc(proof.status)}" title="${esc(`${p.label}${proof.fix ? ` for #${proof.fix}` : ''}: ${p.title}`)}">${esc(p.mark)} ${esc(p.label)}</span>`;
}

/** The proof in words, with the fix and both commits linked, for the row's collapsible. */
export function proofText(proof) {
    const p = PROOF[proof.status] || {label: proof.status, title: ''};
    const commit = (sha) => (sha ? `<a class="mono" href="${BASE}/commit/${esc(sha)}">${esc(short(sha))}</a>` : '?');
    const fix = proof.fix ? `<a href="${BASE}/pull/${esc(proof.fix)}">#${esc(proof.fix)}</a>` : 'the fix';
    return `Proof: <span class="proof ${esc(proof.status)}">${esc(p.label)}</span> - ${p.title}: ${fix}, parent ${commit(proof.parent)}, merge ${commit(proof.merge)}${proof.date ? ` (${esc(String(proof.date).slice(0, 10))})` : ''}.`;
}

/** The proof summary of a report (report.proof, task 30): counts per status over the fixes. */
export function proofCounts(proof) {
    const counts = {};
    for (const f of Object.values((proof && proof.fixes) || {})) {
        counts[f.status] = (counts[f.status] || 0) + 1;
    }
    return counts;
}

/** The test rows of a run: one per file, nesting and name, with the result of every job that ran it. */
export function testRows(jobs) {
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
    return [...byName.values()];
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
        `<p class="muted">${esc(report.generatedAt)}${report.repoSha ? ` · <a href="${esc(report.repoUrl)}" class="mono">${esc(report.repoSha.slice(0, 7))}</a>` : ''}${report.ref ? ` · ${esc(report.ref)}` : ''}${report.runUrl ? ` · <a href="${esc(report.runUrl)}">CI run ${esc(report.runId)}</a>` : ''}${report.trigger ? ` · triggered by ${triggerHtml(report.trigger)}` : ''} · <a href="${REPO}">repository</a> · <a href="report.json">report.json</a></p>`,
    );
    // the trend needs the current run first (writeSite passes it so; a bare call gets it added)
    h.push(
        renderTrendPanel(
            report,
            history[0] && history[0].id === report.id ? history : [historyEntry(report), ...history],
        ),
    );
    h.push(`<div class="cards">`);
    if (report.proof && report.proof.fixes) {
        // task 30: each fixed upstream bug's regression tests run on the fix's parent and merge commits
        const pc = proofCounts(report.proof);
        const parts = Object.keys(PROOF)
            .filter((k) => pc[k])
            .map((k) => `<span class="proof ${k}">${pc[k]} ${esc(PROOF[k].label)}</span>`);
        h.push(
            `<div class="card"><div class="big ${pc['not-proven'] ? 'fail' : 'pass'}">${pc.proven || 0}/${Object.keys(report.proof.fixes).length}</div><div class="label">fixes proven (fail on parent, pass on merge)${parts.length ? `<br>${parts.join(' · ')}` : ''}</div></div>`,
        );
    }
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

    // one result column per OpenCCU-Base ref (scripts/combine.mjs): the variants show only where they differ
    const refs = groupByRef(jobs);
    const rows = [...byName.values()];
    const counts = refCounts(rows, refs);
    const legend = `<span class="chip">A</span> ASan, <span class="chip">C</span> coverage, <span class="chip">R</span> release: the variant(s) with the shown result where the variants of a ref differ (the coverage variant counts only where it differs from release)`;

    // Jobs: one row per ref - commit, the variants with their durations, the combined counts
    h.push(
        `<h2>Jobs</h2><p class="muted">The OpenCCU-Base refs side by side, oldest first: the two newest release tags and the head of main, chosen anew on every run (scripts/resolve-refs.mjs). A test is todo on a ref that lacks its fix's merge commit. The counts combine the variants: a test counts with its worst result.</p>`,
    );
    h.push(
        table(
            [
                {label: 'OpenCCU-Base'},
                {label: 'commit', cls: 'c'},
                {label: 'variants', cls: 'v'},
                {label: 'pass', cls: 'r'},
                {label: 'fail', cls: 'r'},
                {label: 'todo', cls: 'r'},
                {label: 'skip', cls: 'r'},
            ],
            counts.map(({ref, counts: c, differing}) => {
                const known = ref.jobs[0] && ref.jobs[0].knownBroken.length ? ref.jobs[0].knownBroken : [];
                const perVariant = ref.jobs
                    .map(
                        (j) =>
                            `<li><span class="mono">${esc(j.variant)}</span>: ${esc(seconds(j.durationMs))} · <span class="pass">${j.counts.pass}</span> / <span class="fail">${j.counts.fail}</span> / <span class="todo">${j.counts.todo}</span> / <span class="skip">${j.counts.skip}</span></li>`,
                    )
                    .join('');
                const summary = `${esc(ref.ref)}${differing ? ` <span class="chip" title="rows where the variants differ">${differing} differ</span>` : ''}`;
                const body = `<ul class="plain">${perVariant}</ul>${known.length ? `<div class="diag">known broken: ${esc(known.join(', '))}</div>` : ''}`;
                return [
                    `<details class="row"><summary>${summary}<span class="phone-only mono"> ${esc(short(ref.baseCommit))}</span></summary>${body}</details>`,
                    `<a class="mono" href="${BASE}/commit/${esc(ref.baseCommit)}">${esc(short(ref.baseCommit))}</a>`,
                    `<span class="variants">${ref.jobs.map((j) => `<span class="vd" title="${esc(j.variant)}: ${esc(seconds(j.durationMs))}">${esc(VARIANT_CHIP[j.variant] || j.variant)} ${esc(seconds(j.durationMs))}</span>`).join(' ')}</span>`,
                    `<span class="pass">${c.pass}</span>`,
                    `<span class="fail">${c.fail}</span>`,
                    `<span class="todo">${c.todo}</span>`,
                    `<span class="skip">${c.skip}</span>`,
                ];
            }),
        ),
    );

    // Tests: one line per test at load; the explanation, diagnostics and per-variant results behind a collapsible
    const differingRows = rows.filter((row) => refs.some((ref) => (combine(row.results, ref) || {}).differs));
    h.push(
        `<h2 id="tests">Tests</h2><p class="muted">One column per OpenCCU-Base ref; each row opens to what the test does, its diagnostics and the per-variant results. ${legend}. <span class="badge kind-regression">regression</span> pins an upstream fix; <span class="badge kind-known-bug">known bug</span> is a finding of this suite without an upstream fix (todo everywhere); <span class="badge kind-behaviour">behaviour</span> a measured daemon behaviour; <span class="badge kind-fuzz">fuzz</span> a seeded fuzzing test. A <span class="todo">todo</span> is a test on a ref that predates the fix. ${differingRows.length ? `<a href="#differing">Only the ${differingRows.length} row(s) where the variants differ</a>.` : 'The variants agree in every row.'}</p>`,
    );
    const testHead = [
        {label: 'test'},
        {label: 'kind', cls: 'k'},
        {label: 'links', cls: 'l'},
        ...refs.map((ref) => ({
            label: `${esc(ref.ref)} <a class="mono muted" href="${BASE}/commit/${esc(ref.baseCommit)}">${esc(short(ref.baseCommit))}</a>`,
            cls: 'r',
            raw: true,
        })),
    ];
    const testRow = (row) => {
        const first = [...row.results.values()][0];
        const kindBadge = `<span class="badge kind-${esc(row.kind)}">${esc(row.kind.replace('-', ' '))}</span>`;
        const links = (first.refs || []).map((ref) => `<a href="${esc(ref.url)}">${esc(ref.label)}</a>`);
        const combined = refs.map((ref) => combine(row.results, ref));
        // behind the collapsible: the explanation, the errors and diagnostics, the per-variant results where they differ
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
        let body = `<p class="what">${esc(first.description || 'No description yet.')}</p>`;
        const proof = [...row.results.values()].map((r) => r.proof).find(Boolean);
        if (proof) {
            body += `<div class="diag">${proofText(proof)}</div>`;
        }
        body += `<div class="phone-only">${kindBadge}${links.length ? ' ' + links.join(' · ') : ''}</div>`;
        for (const e of errors) {
            body += `<div class="err">${esc(e)}</div>`;
        }
        for (const d of diags) {
            body += `<div class="diag">${esc(d)}</div>`;
        }
        combined.forEach((c, i) => {
            if (c && c.differs) {
                body += `<div class="diag">${esc(refs[i].ref)}: ${c.variants.map((v) => `${esc(v.variant)} <span class="${v.status}">${esc(STATUS_MARK[v.status] || v.status)} ${esc(v.status)}</span> ${esc(duration(v.durationMs))}`).join(' · ')}</div>`;
            }
        });
        const name = `<details class="row"><summary>${row.nesting > 0 ? '<span class="sub"></span>' : ''}${esc(row.name)}</summary>${body}</details>`;
        const cells = [name, kindBadge + (proof ? ' ' + proofMark(proof) : ''), links.join(' · ')];
        combined.forEach((c) => {
            if (!c) {
                cells.push(`<span class="muted">-</span>`);
                return;
            }
            const title = c.variants
                .map((v) => {
                    const note =
                        typeof v.todo === 'string' ? `: ${v.todo}` : typeof v.skip === 'string' ? `: ${v.skip}` : '';
                    return `${v.variant}: ${v.status} ${duration(v.durationMs)}${note}`;
                })
                .join('\n');
            const chips = c.chips.map((x) => `<span class="chip ${c.status}">${esc(x)}</span>`).join('');
            cells.push(
                `<span class="${c.status}${c.differs ? ' differs' : ''}" title="${esc(title)}">${esc(STATUS_MARK[c.status] || c.status)} <span class="word">${esc(c.status)}</span>${chips ? ' ' + chips : ''}</span>`,
            );
        });
        // what the filter (task 37) matches on
        const results = combined.filter(Boolean);
        const attrs = {
            'data-row': '',
            'data-result': [...new Set(results.map((c) => c.status))].join(' '),
            'data-daemon': daemonOf(row),
            'data-kind': row.kind,
            'data-differs': results.some((c) => c.differs) ? 'yes' : 'no',
            'data-proof': proof ? proof.status : '',
            'data-text': `${row.name} ${row.file} ${first.description || ''}`.toLowerCase(),
        };
        combined.forEach((c, i) => {
            attrs[`data-r${i}`] = c ? c.status : '';
        });
        return {cells, attrs};
    };
    // the filter bar (task 37): hidden until its script runs, so without JavaScript every row stays visible
    h.push(
        renderFilterBar(
            rows.map(testRow).map((r) => r.attrs),
            refs.map((r) => r.ref),
        ),
    );
    h.push(`<div id="test-tables">`);
    for (const [file, fileRows] of files) {
        h.push(`<section class="test-file"><h3 class="mono">${esc(file || '?')}</h3>`);
        h.push(table(testHead, fileRows.map(testRow)));
        h.push(`</section>`);
    }
    h.push(`</div>`);
    // the rows where the variants differ, on their own (no JavaScript needed: a plain anchor)
    h.push(
        `<h2 id="differing">Rows where the variants differ</h2><p class="muted">${differingRows.length ? `${differingRows.length} row(s). ${legend}.` : 'None: release, ASan and coverage agree in every row.'} <a href="#tests">All tests</a>.</p>`,
    );
    if (differingRows.length) {
        h.push(table(testHead, differingRows.map(testRow)));
    }

    // Coverage: component | kind | files | lines | functions | branches (per ref, the coverage variant's job)
    const covered = jobs.filter((j) => j.coverage);
    if (covered.length) {
        h.push(
            `<h2>Coverage</h2><p class="muted">What the suite reaches in the daemons' own sources and in the libraries they load, from the coverage variant (clang source-based coverage, -O0). The daemons and each library are their own rows, so a daemon's percentage is neither diluted nor inflated by the libraries. The data (an lcov tracefile and llvm-cov's JSON, file paths and counts, no source text) is linked per ref: with an OpenCCU-Base checkout at that commit, <code class="mono">genhtml --prefix /openccu-base coverage.info</code> renders the annotated view.</p>`,
        );
        for (const job of covered) {
            const links = (job.coverageLinks || [])
                .map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`)
                .join(' · ');
            h.push(
                `<h3>${esc(job.ref)} <span class="muted">(<a class="mono" href="${BASE}/commit/${esc(job.baseCommit)}">${esc(short(job.baseCommit))}</a>${links ? ' · ' + links : ''})</span></h3>`,
            );
            h.push(
                table(
                    [
                        {label: 'component'},
                        {label: 'kind', cls: 'k'},
                        {label: 'files', cls: 'r'},
                        {label: 'lines', cls: 'r'},
                        {label: 'functions', cls: 'r'},
                        {label: 'branches', cls: 'r'},
                    ],
                    job.coverage.components
                        .filter((c) => c.linesTotal > 0)
                        .map((c) => [
                            `<span class="mono">src/${esc(c.component)}</span>`,
                            esc(c.kind),
                            String(c.files.length),
                            `${esc(pctText(c.lines))}<br><span class="muted">${c.linesHit}/${c.linesTotal}</span>`,
                            `${esc(pctText(c.functions))}<br><span class="muted">${c.functionsHit}/${c.functionsTotal}</span>`,
                            `${esc(pctText(c.branches))}<br><span class="muted">${c.branchesHit}/${c.branchesTotal}</span>`,
                        ]),
                ),
            );
            const daemons = job.coverage.components.filter((c) => c.kind === 'daemon');
            for (const c of daemons) {
                h.push(
                    `<details><summary class="muted">per file: src/${esc(c.component)} (${c.files.length} files)</summary>`,
                );
                h.push(
                    table(
                        [
                            {label: 'file'},
                            {label: 'lines hit', cls: 'r'},
                            {label: 'of', cls: 'r'},
                            {label: 'lines', cls: 'r'},
                            {label: 'branches', cls: 'r'},
                        ],
                        c.files.map((f) => [
                            `<span class="mono">${esc(f.file)}</span>`,
                            String(f.linesHit),
                            String(f.linesTotal),
                            esc(pctText(f.lines)),
                            esc(pctText(f.branches)),
                        ]),
                    ),
                );
                h.push(`</details>`);
            }
        }
    }

    // Load: run | ref | offered | achieved | p95 | events
    if ((report.load || []).length) {
        h.push(
            `<h2>Load</h2><p class="muted">rfd under fast setValue/putParamset bursts on the air model with computed airtime (9992.6 baud, 0.8 ms per byte, 10 ms gaps; the 1 % duty cycle in a scaled window) - computed, not measured. rfd sends one exchange at a time and answers the call after the ACK.</p>`,
        );
        h.push(
            table(
                [
                    {label: 'run'},
                    {label: 'OpenCCU-Base', cls: 'c'},
                    {label: 'offered/s', cls: 'r'},
                    {label: 'achieved/s', cls: 'r'},
                    {label: 'p95 ms', cls: 'r'},
                    {label: 'events', cls: 'r'},
                ],
                report.load.map((r) => [
                    `${esc(r.run)}<div class="diag">${esc(r.note)}</div>`,
                    esc(r.ref),
                    esc(String(r.offered ?? '-')),
                    esc(String(r.achieved ?? '-')),
                    esc(String(r.p95 ?? '-')),
                    esc(r.events),
                ]),
            ),
        );
    }

    // listMethods: daemon over protocol | ref | listed | callable | unlisted callable | help gaps
    if ((report.listMethods || []).length) {
        h.push(
            `<h2>listMethods tells the truth</h2><p class="muted">Every name <code class="mono">system.listMethods</code> returns must be known to the dispatcher (asked through <code class="mono">system.methodHelp</code>, the harmless ones also called), and no other name may be: the daemons' own source names, the other daemon's, names of other Homematic interfaces, case and whitespace variants. <code class="mono">system.multicall</code> is built into the connection, so methodHelp does not know it.</p>`,
        );
        h.push(
            table(
                [
                    {label: 'daemon, callbacks'},
                    {label: 'OpenCCU-Base', cls: 'c'},
                    {label: 'listed', cls: 'r'},
                    {label: 'callable', cls: 'r'},
                    {label: 'unlisted callable', cls: 'r'},
                    {label: 'help gaps', cls: 'r'},
                ],
                report.listMethods.map((r) => [
                    `${esc(r.daemon)} <span class="muted">${esc(r.protocol)}</span>`,
                    esc(r.ref),
                    `<span class="${r.callable === r.listed ? 'pass' : 'fail'}">${r.listed}</span>`,
                    `<span class="${r.callable === r.listed ? 'pass' : 'fail'}">${r.callable}</span>`,
                    r.unlistedCallable.length
                        ? `<span class="fail" title="${esc(r.unlistedCallable.join(', '))}">${r.unlistedCallable.length}</span>`
                        : '<span class="pass">0</span>',
                    `<span class="muted" title="${esc(r.helpGaps.join(', '))}">${r.helpGaps.length}</span>`,
                ]),
            ),
        );
    }

    // Differential: the sweeps' answers compared between refs (scripts/differential.mjs)
    if ((report.differential || []).length) {
        h.push(
            `<h2>Differential</h2><p class="muted">The answers of the RPC method sweep and the device-type sweep (release variant), compared between the refs of this run and with the main commit the previous report tested. A change is not a failure: it shows what a consumer of the daemons sees change.</p>`,
        );
        for (const section of report.differential) {
            const d = section.diff;
            h.push(
                `<h3>${esc(section.title)}: <a class="mono" href="${BASE}/commit/${esc(section.from.baseCommit)}">${esc(short(section.from.baseCommit))}</a> → <a class="mono" href="${BASE}/commit/${esc(section.to.baseCommit)}">${esc(short(section.to.baseCommit))}</a></h3>`,
            );
            h.push(
                `<p>${d.changed} changed, ${d.added} added, ${d.removed} removed, ${d.equal} equal${d.ignored ? `, ${d.ignored} ignored by design` : ''}.</p>`,
            );
            if (d.items.length) {
                h.push(
                    `<details><summary>the differences${d.items.length < d.changed + d.added + d.removed ? ` (the first ${d.items.length})` : ''}</summary>`,
                );
                // a list, not a table: the answers are long texts that do not fit the tables' column scheme
                h.push(
                    `<ul class="diff">${d.items
                        .map(
                            (item) =>
                                `<li><span class="muted">${esc(item.sweep)}</span> <span class="mono">${esc(item.key)}</span>: ${item.from === null ? '<span class="muted">(new)</span>' : `<span class="mono">${esc(item.from)}</span>`} → ${item.to === null ? '<span class="muted">(gone)</span>' : `<span class="mono">${esc(item.to)}</span>`}</li>`,
                        )
                        .join('\n')}</ul>`,
                );
                h.push(`</details>`);
            }
        }
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
                            ? `<span class="${run.expected || hz.known ? 'todo' : 'fail'}" title="${esc(hz.findings.map((f) => f.type).join(', '))}">${hz.findings.length}${hz.known ? ` <span class="muted">(known: ${esc(hz.known)})</span>` : run.expected ? ' <span class="muted">(expected)</span>' : ''}</span>`
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
                    `<a href="runs/${esc(entry.id)}/">${esc(entry.generatedAt)}</a>${entry.runUrl ? ` <a class="muted" href="${esc(entry.runUrl)}">(CI)</a>` : ''}${entry.trigger ? `<div class="diag">triggered by ${triggerHtml(entry.trigger)}</div>` : ''}${coverageLine(entry)}`,
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
    h.push(`<script>${FILTER_SCRIPT}</script>`);
    h.push(`</body></html>`);
    return h.join('\n') + '\n';
}

/** "OpenCCU-Base <sha>" with the commit linked, any other trigger text as it is. */
function triggerHtml(trigger) {
    const m = /^OpenCCU-Base ([0-9a-f]{7,40})$/.exec(trigger);
    if (m) {
        return `OpenCCU-Base <a class="mono" href="${BASE}/commit/${esc(m[1])}">${esc(m[1].slice(0, 7))}</a>`;
    }
    return esc(trigger);
}

/** "coverage main: rfd 12.3 %, hs485d 20.1 %" for a history entry, or nothing. */
function coverageLine(entry) {
    if (!entry.coverage || !Object.keys(entry.coverage).length) {
        return '';
    }
    const parts = Object.entries(entry.coverage).map(
        ([ref, daemons]) =>
            `${esc(ref)}: ${Object.entries(daemons)
                .map(([d, v]) => `${esc(d)} ${esc(pctText(v))}`)
                .join(', ')}`,
    );
    return `<div class="diag">coverage ${parts.join(' · ')}</div>`;
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
        trigger: report.trigger || '',
        runId: report.runId,
        runUrl: report.runUrl,
        status: report.status,
        ...totals,
        fuzzFindings: unexpectedFuzzFindings(report.fuzz),
        trend: trendOf(report),
        coverage: Object.fromEntries(
            report.jobs
                .filter((j) => j.coverage)
                .map((j) => [
                    j.ref,
                    Object.fromEntries(
                        j.coverage.components.filter((c) => c.kind === 'daemon').map((c) => [c.component, c.lines]),
                    ),
                ]),
        ),
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
    // entries from before the trend panel get their trend from the kept run's report.json
    for (const entry of history.slice(1)) {
        const file = previous ? path.join(previous, 'runs', entry.id, 'report.json') : null;
        if (!entry.trend && file && fs.existsSync(file)) {
            try {
                entry.trend = trendOf(readJson(file));
            } catch {
                // a report the trend cannot read is a gap
            }
        }
    }

    fs.mkdirSync(out, {recursive: true});
    for (const entry of history.slice(1)) {
        const src = previous ? path.join(previous, 'runs', entry.id) : null;
        const dst = path.join(out, 'runs', entry.id);
        if (src && fs.existsSync(src) && path.resolve(src) !== path.resolve(dst)) {
            fs.cpSync(src, dst, {recursive: true});
        }
    }
    const runDir = path.join(out, 'runs', report.id);
    fs.mkdirSync(runDir, {recursive: true});
    for (const job of report.jobs) {
        if (!job.coverageFiles) {
            continue;
        }
        job.coverageLinks = [];
        for (const src of job.coverageFiles) {
            const ext = path.extname(src);
            const name = `coverage-${job.ref.replace(/[^A-Za-z0-9.-]/g, '_')}-${short(job.baseCommit)}-${short(report.repoSha) || 'local'}${ext}`;
            fs.copyFileSync(src, path.join(runDir, name));
            job.coverageLinks.push({
                label: ext === '.info' ? 'lcov tracefile' : 'llvm-cov JSON',
                href: `runs/${report.id}/${name}`,
            });
        }
        delete job.coverageFiles;
    }
    // the sweep records of the release jobs: the next run diffs main against sweep/main.json
    for (const job of report.jobs.filter((j) => j.variant === 'release' && j.sweep)) {
        fs.mkdirSync(path.join(out, 'sweep'), {recursive: true});
        fs.writeFileSync(
            path.join(out, 'sweep', `${job.ref.replace(/[^A-Za-z0-9.-]/g, '_')}.json`),
            JSON.stringify({ref: job.ref, baseCommit: job.baseCommit, records: job.sweep}) + '\n',
        );
    }
    const html = renderHtml(report, history);
    fs.writeFileSync(path.join(runDir, 'index.html'), html);
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 1) + '\n');
    fs.writeFileSync(path.join(out, 'index.html'), html);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1) + '\n');
    fs.writeFileSync(path.join(out, 'summary.md'), renderSummaryMarkdown(report) + '\n');
    fs.writeFileSync(path.join(out, 'history.json'), JSON.stringify(history, null, 1) + '\n');
    if (report.proof) {
        // the next run keeps it when it does not prove (scripts/prove.mjs collect --previous)
        fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify(report.proof, null, 1) + '\n');
    }
    fs.writeFileSync(path.join(out, '.nojekyll'), '');
    return history;
}

// ---------------------------------------------------------------------------------------------------------------
// command line

/** The main sweep records of the published report before this run (`<previous>/sweep/main.json`), or null. */
function readPreviousMain(previous) {
    const file = previous ? path.join(previous, 'sweep', 'main.json') : null;
    if (!file || !fs.existsSync(file)) {
        return null;
    }
    try {
        return readJson(file);
    } catch {
        return null;
    }
}

/** The proof of the regression tests (scripts/prove.mjs collect), or null. */
function readProof(file) {
    if (!file || !fs.existsSync(file)) {
        return null;
    }
    try {
        return readJson(file);
    } catch {
        return null;
    }
}

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
            trigger: options.trigger,
        });
        process.stdout.write(renderSummaryMarkdown(report) + '\n');
        return 0;
    }
    if (command === 'check') {
        const missing = missingDescriptions(collectResults(options.roots));
        for (const m of missing) {
            console.error(`no description: ${m.file}: ${m.name}`);
        }
        console.log(
            missing.length
                ? `${missing.length} test(s) without a description - add them to test/descriptions.js`
                : 'every test has a description',
        );
        return missing.length ? 1 : 0;
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
            trigger: options.trigger,
            previousMain: readPreviousMain(options.previous),
            proof: readProof(options.proof),
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
