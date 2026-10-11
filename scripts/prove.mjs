#!/usr/bin/env node
/**
 * The proof of the regression tests: a regression test only shows something if it fails without its fix. For every
 * upstream fix in test/metadata.js (UPSTREAM_FIXES) this builds the daemons at the fix's parent (`<merge commit>^`) and
 * at the merge commit, runs only the tests whose top-level name carries the fix's number (`#<n>`), release and ASan,
 * and records the outcome:
 *
 *   proven        at least one test fails on the parent and passes on the merge commit (in every variant)
 *   not-proven    every test passes on the parent too: the test does not reach what the fix changed
 *   inconclusive  the tests fail on the parent, but on the merge commit too
 *   no-build      a side does not build with this repository's image (commits before CMake, or a broken commit)
 *   no-tests      no test carries the number
 *   incomplete    one side did not report (its job was cancelled)
 *
 * Races and lifetime bugs (`proofRepeat` in UPSTREAM_FIXES) run up to that many times on the parent under ASan before
 * they count as not proven. On the parent the fix is in the known-broken list, so its tests run as todo there: a todo
 * still records whether its body passed (`outcome` in tests.json, scripts/json-reporter.mjs).
 *
 * Usage:
 *   prove.mjs plan [--fixes 9,16] [--repo <url>] [--github-output]
 *       the jobs, one per fix and side: {fix, side, sha, known_broken, pattern, repeat}; with --github-output also
 *       `proof=` to $GITHUB_OUTPUT (the CI's prove matrix)
 *   prove.mjs run --fix <n> --side parent|merge --sha <sha> --image <tag> --out <dir> [--known-broken <list>]
 *                 [--repeat <k>] [--variants release,asan] [--build-failed] [--lock <file>]
 *       runs the fix's tests in the image, writes <dir>/proof-run.json
 *   prove.mjs collect <dir>... --out <proof.json> [--previous <proof.json>]
 *       judges every fix from the runs below the directories; fixes without runs keep their previous entry
 *   prove.mjs changed <from> <to>
 *       exit 0 when the commits between need a new proof (the CI's push trigger; proofRelevant)
 *   prove.mjs local [--fixes 9,16] [--out <dir>] [--lock <file>]
 *       plan, build (docker), run and collect on this machine; the docker steps under the lock (default: the main
 *       checkout's .docker.lock, as scripts/run-tests.sh)
 */

import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {UPSTREAM_FIXES} from '../test/metadata.js';
import {knownBroken} from './refs.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPO = 'https://github.com/OpenCCU/OpenCCU-Base.git';
export const PROOF_VARIANTS = Object.freeze(['release', 'asan']);

/** The name pattern that selects a fix's tests: `#9` but not `#90`. */
export function proofPattern(fix) {
    return `#${fix}(?!\\d)`;
}

// ---------------------------------------------------------------------------------------------------------------
// plan

/**
 * @param {{fixes?: number[], parentOf: (sha: string) => string, contains: (commit: string, sha: string) => boolean}} o
 */
export function planJobs({fixes, parentOf, contains}, all = UPSTREAM_FIXES) {
    const numbers = (fixes && fixes.length ? fixes : Object.keys(all).map(Number)).sort((a, b) => a - b);
    const jobs = [];
    for (const fix of numbers) {
        const entry = all[fix];
        if (!entry) {
            throw new Error(`#${fix} is not in UPSTREAM_FIXES`);
        }
        for (const side of ['parent', 'merge']) {
            const sha = side === 'merge' ? entry.commit : parentOf(entry.commit);
            jobs.push({
                fix,
                side,
                sha,
                merge: entry.commit,
                known_broken: knownBroken((commit) => contains(commit, sha), all).join(','),
                pattern: proofPattern(fix),
                repeat: side === 'parent' ? entry.proofRepeat || 1 : 1,
            });
        }
    }
    return jobs;
}

function plan({repo = DEFAULT_REPO, fixes} = {}) {
    // the history without file contents, as scripts/resolve-refs.mjs
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'openccu-base-proof-'));
    try {
        execFileSync('git', ['clone', '--quiet', '--bare', '--filter=tree:0', repo, dir], {stdio: 'inherit'});
        const git = (...args) =>
            execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
        const contains = (commit, sha) =>
            spawnSync('git', ['-C', dir, 'merge-base', '--is-ancestor', commit, sha], {stdio: 'ignore'}).status === 0;
        return planJobs({fixes, parentOf: (sha) => git('rev-parse', `${sha}^1`), contains});
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
}

// ---------------------------------------------------------------------------------------------------------------
// run

/** The test records of one tests.json, reduced to what the proof needs. */
export function proofTests(testsJson) {
    return (
        (testsJson.tests || [])
            .filter((t) => t.status !== 'skip')
            // node:test reports every file as a test of its own; a file whose tests were all filtered out passes - noise,
            // but a file that failed (a crash outside any test) stays
            .filter((t) => !(t.nesting === 0 && /\.test\.js$/.test(t.name) && t.status === 'pass'))
            .map((t) => ({
                file: t.file,
                nesting: t.nesting,
                name: t.name,
                // tests.json written before `outcome` existed: a todo's own status says nothing, a plain one does
                outcome: t.outcome || (t.status === 'fail' ? 'fail' : 'pass'),
                ...(t.error && (t.outcome === 'fail' || t.status === 'fail') ? {error: t.error} : {}),
            }))
    );
}

/** A suite that did not write its results (the daemon took node down, the container died) is a failure of its own. */
const NO_RESULTS = {file: null, nesting: 0, name: '(the suite did not finish: no tests.json)', outcome: 'fail'};

const RUN_TIMEOUT_MS = Number(process.env.HMRS_PROOF_TIMEOUT_MS || 30 * 60 * 1000);

function withLock(lock, cmd, args, options = {}) {
    return lock ? spawnSync('flock', [lock, cmd, ...args], options) : spawnSync(cmd, args, options);
}

function runSide(o) {
    const record = {
        fix: Number(o.fix),
        side: o.side,
        sha: o.sha,
        date: new Date().toISOString(),
        build: o.buildFailed ? 'failed' : 'ok',
        variants: {},
    };
    if (!o.buildFailed) {
        for (const variant of o.variants) {
            // the parent may need several runs to show a race; the merge commit runs once
            const repeat = o.side === 'parent' && variant === 'asan' ? Number(o.repeat || 1) : 1;
            const v = {runs: 0, failedRun: null, tests: []};
            for (let i = 1; i <= repeat; i++) {
                let results = path.resolve(o.out, `${variant}-${i}`);
                try {
                    fs.rmSync(results, {recursive: true, force: true});
                } catch {
                    results += `-${Date.now()}`; // left root-owned by a container that was killed
                }
                fs.mkdirSync(results, {recursive: true});
                const name = `hmrs-proof-${o.fix}-${o.side}-${variant}-${i}-${process.pid}`;
                const args = ['run', '--rm', '--init', '--cap-add', 'SYS_NICE', '--name', name];
                args.push('-e', `HMRS_VARIANT=${variant}`, '-e', `HMRS_TEST_NAME_PATTERN=${o.pattern}`);
                if (o.knownBroken !== undefined) {
                    args.push('-e', `HMRS_KNOWN_BROKEN=${o.knownBroken}`);
                }
                args.push('-v', `${results}:/results`, o.image, 'npm', 'run', 'test:daemon');
                // a test file that never ends (a server left open after a failed assertion) must not stall the proof;
                // the timeout runs inside the lock, so waiting for another checkout's docker work does not count
                const r = withLock(
                    o.lock,
                    'timeout',
                    ['--kill-after=30', String(Math.round(RUN_TIMEOUT_MS / 1000)), 'docker', ...args],
                    {stdio: ['ignore', 'inherit', 'inherit']},
                );
                spawnSync('docker', ['rm', '-f', name], {stdio: 'ignore'});
                v.runs = i;
                const data = readJsonOr(path.join(results, variant, 'tests.json'), null);
                const tests = data ? proofTests(data) : [NO_RESULTS];
                v.exit = r.status;
                if (r.status === 124) {
                    v.timedOut = true;
                }
                v.tests = tests;
                if (tests.some((t) => t.outcome === 'fail')) {
                    v.failedRun = i;
                    break;
                }
            }
            record.variants[variant] = v;
        }
    }
    fs.mkdirSync(o.out, {recursive: true});
    fs.writeFileSync(path.join(o.out, 'proof-run.json'), JSON.stringify(record, null, 1) + '\n');
    return record;
}

// ---------------------------------------------------------------------------------------------------------------
// judging

const key = (t) => `${t.file}\u0000${t.nesting}\u0000${t.name}`;

/** Per test of one side: 'fail' when it failed in any variant (any run), else 'pass'. */
function outcomes(run) {
    const map = new Map();
    for (const v of Object.values(run.variants || {})) {
        for (const t of v.tests) {
            const prev = map.get(key(t));
            map.set(key(t), {
                file: t.file,
                nesting: t.nesting,
                name: t.name,
                outcome: prev && prev.outcome === 'fail' ? 'fail' : t.outcome,
                error: (prev && prev.error) || t.error,
            });
        }
    }
    return map;
}

/**
 * Judges one fix from its two runs.
 * @param {object|undefined} parent the parent's proof-run.json
 * @param {object|undefined} merge the merge commit's proof-run.json
 */
export function judgeFix(fix, parent, merge, all = UPSTREAM_FIXES) {
    const entry = {
        fix: Number(fix),
        title: all[fix] ? all[fix].title : '',
        merge: all[fix] ? all[fix].commit : merge && merge.sha,
        parent: parent ? parent.sha : null,
        date: [parent, merge]
            .filter(Boolean)
            .map((r) => r.date)
            .sort()
            .pop(),
        repeat: (all[fix] && all[fix].proofRepeat) || 1,
        status: 'no-tests',
        failedOnParent: [],
        passedOnMerge: false,
        tests: [],
    };
    if (!parent || !merge) {
        entry.status = 'incomplete'; // a side did not report (a cancelled job)
        entry.missing = [!parent && 'parent', !merge && 'merge'].filter(Boolean);
        return entry;
    }
    if (parent.build !== 'ok' || merge.build !== 'ok') {
        entry.status = 'no-build';
        entry.noBuild = [parent, merge].filter((r) => r.build !== 'ok').map((r) => r.side);
        return entry;
    }
    const p = outcomes(parent);
    const m = outcomes(merge);
    for (const k of new Set([...p.keys(), ...m.keys()])) {
        const t = p.get(k) || m.get(k);
        const po = p.has(k) ? p.get(k).outcome : 'absent';
        const mo = m.has(k) ? m.get(k).outcome : 'absent';
        entry.tests.push({
            file: t.file,
            nesting: t.nesting,
            name: t.name,
            parent: po,
            merge: mo,
            proves: po === 'fail' && mo === 'pass',
            ...(po === 'fail' && p.get(k).error ? {parentError: p.get(k).error} : {}),
        });
    }
    const parentRuns = Object.fromEntries(Object.entries(parent.variants).map(([v, r]) => [v, r.runs]));
    entry.parentRuns = parentRuns;
    if (entry.tests.length === 0) {
        return entry;
    }
    entry.failedOnParent = entry.tests.filter((t) => t.parent === 'fail').map((t) => t.name);
    entry.passedOnMerge = entry.tests.every((t) => t.merge === 'pass');
    if (entry.tests.some((t) => t.proves)) {
        entry.status = 'proven';
    } else if (entry.failedOnParent.length === 0) {
        entry.status = 'not-proven';
    } else {
        entry.status = 'inconclusive';
    }
    return entry;
}

/**
 * The proof of a set of runs, merged over the previous proof: a fix without runs here keeps its previous entry.
 * @param {object[]} runs proof-run.json records
 * @param {object|null} previous the previous proof.json
 */
export function collectProof(runs, previous = null, all = UPSTREAM_FIXES) {
    const bySide = new Map();
    for (const r of runs) {
        bySide.set(`${r.fix}/${r.side}`, r);
    }
    const fixes = {};
    for (const [number, entry] of Object.entries((previous && previous.fixes) || {})) {
        if (all[number]) {
            fixes[number] = entry; // a fix taken out of UPSTREAM_FIXES leaves the proof too
        }
    }
    for (const fix of new Set(runs.map((r) => r.fix))) {
        fixes[fix] = judgeFix(fix, bySide.get(`${fix}/parent`), bySide.get(`${fix}/merge`), all);
    }
    return {generatedAt: new Date().toISOString(), fixes};
}

/**
 * Whether a test of the report is proven, from its pull-request references and the proof.
 * @param {{file: string, nesting: number, name: string, refs?: Array<{kind: string, label: string}>}} test
 * @returns {{status: 'proven'|'not-proven'|'inconclusive'|'no-build'|'incomplete', fix: number, parent: string, merge: string,
 *   date: string}|null} the `proof` field of a test in report.json: `proven` when this test failed on the fix's parent
 *   and passed on the merge commit; else the fix's status when the proof ran this test (`not-proven`: the test passed on
 *   the parent too, or another test of the fix proved it but not this one); null when the proof knows nothing of it
 */
export function proofForTest(test, proof) {
    if (!proof || !proof.fixes) {
        return null;
    }
    let found = null;
    for (const ref of test.refs || []) {
        if (ref.kind !== 'pr') {
            continue;
        }
        const fix = Number(ref.label.replace(/^.*#/, ''));
        const entry = proof.fixes[fix];
        if (!entry) {
            continue;
        }
        const t = (entry.tests || []).find(
            (x) => x.file === test.file && x.nesting === test.nesting && x.name === test.name,
        );
        const about = {fix, parent: entry.parent, merge: entry.merge, date: entry.date};
        if (t && t.proves) {
            return {status: 'proven', ...about};
        }
        if (t || (entry.status === 'no-build' && test.nesting === 0)) {
            found = found || {status: entry.status === 'proven' ? 'not-proven' : entry.status, ...about};
        }
    }
    return found;
}

// ---------------------------------------------------------------------------------------------------------------
// when to prove

/** Files whose change can change a proof: the fix list, the todo mechanism, the proof itself and its inputs. */
export const PROOF_FILES = Object.freeze([
    'test/metadata.js',
    'test/helpers/known.js',
    'scripts/prove.mjs',
    'scripts/json-reporter.mjs',
    'scripts/docker-entrypoint.sh',
]);

/**
 * Whether a change needs a new proof: it touches one of PROOF_FILES, or a changed line of a daemon test carries a fix
 * number (`#13`) or a `regression(<number>)`.
 * @param {string[]} files the changed paths
 * @param {string} diff the unified diff of test/daemon (`git diff -U0`)
 * @returns {string|null} the reason, or null
 */
export function proofRelevant(files, diff) {
    const file = files.find((f) => PROOF_FILES.includes(f));
    if (file) {
        return `${file} changed`;
    }
    const line = diff.split('\n').find((l) => /^[+-](?![+-])/.test(l) && /#\d+|regression\(\s*\d/.test(l));
    return line ? `a regression test changed: ${line.slice(0, 120)}` : null;
}

// ---------------------------------------------------------------------------------------------------------------
// command line

function findRuns(roots) {
    const runs = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true});
        } catch {
            return;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                walk(full);
            } else if (e.name === 'proof-run.json') {
                runs.push(JSON.parse(fs.readFileSync(full, 'utf8')));
            }
        }
    };
    roots.forEach(walk);
    return runs;
}

function readJsonOr(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function defaultLock() {
    try {
        const common = execFileSync('git', ['-C', HERE, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
            encoding: 'utf8',
        }).trim();
        return path.join(path.dirname(common), '.docker.lock');
    } catch {
        return path.join(HERE, '.docker.lock');
    }
}

export function printSummary(proof) {
    const lines = [];
    for (const e of Object.values(proof.fixes).sort((a, b) => a.fix - b.fix)) {
        const provers = e.tests.filter((t) => t.proves).length;
        lines.push(
            `#${e.fix} ${e.status}: ${provers} of ${e.tests.length} tests fail on ${String(e.parent).slice(0, 7)} and pass on ${String(e.merge).slice(0, 7)}${e.noBuild ? ` (does not build: ${e.noBuild.join(', ')})` : ''}`,
        );
    }
    return lines.join('\n');
}

function parseArgs(argv) {
    const o = {roots: []};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--github-output' || a === '--build-failed') {
            o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
        } else if (a.startsWith('--')) {
            o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
        } else {
            o.roots.push(a);
        }
    }
    o.fixList = o.fixes ? o.fixes.split(',').filter(Boolean).map(Number) : undefined;
    o.variantList = o.variants ? o.variants.split(',').filter(Boolean) : [...PROOF_VARIANTS];
    return o;
}

function main(argv) {
    const [command, ...rest] = argv;
    const o = parseArgs(rest);
    if (command === 'plan') {
        const jobs = plan({repo: o.repo, fixes: o.fixList});
        console.log(JSON.stringify(jobs, null, 1));
        if (o.githubOutput && process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `proof=${JSON.stringify(jobs)}\n`);
        }
        return 0;
    }
    if (command === 'changed') {
        const [from, to] = o.roots;
        const git = (...args) => execFileSync('git', ['-C', HERE, ...args], {encoding: 'utf8'});
        const reason = proofRelevant(
            git('diff', '--name-only', from, to).split('\n').filter(Boolean),
            git('diff', '-U0', from, to, '--', 'test/daemon'),
        );
        console.log(reason ? `prove: ${reason}` : 'no change to the fixes or the regression tests');
        return reason ? 0 : 1;
    }
    if (command === 'run') {
        if (!o.fix || !o.side || !o.out || (!o.image && !o.buildFailed)) {
            console.error('run: --fix, --side, --out and --image (or --build-failed) are required');
            return 2;
        }
        const record = runSide({...o, pattern: proofPattern(o.fix), variants: o.variantList});
        console.log(
            `#${record.fix} ${record.side} ${String(record.sha).slice(0, 7)}: build ${record.build}; ${Object.entries(
                record.variants,
            )
                .map(
                    ([v, r]) =>
                        `${v} ${r.tests.filter((t) => t.outcome === 'fail').length} failed of ${r.tests.length} (${r.runs} runs)`,
                )
                .join(', ')}`,
        );
        return 0; // the outcome is data: the collect step judges it
    }
    if (command === 'collect') {
        if (!o.out) {
            console.error('collect: --out <proof.json> is required');
            return 2;
        }
        const runs = findRuns(o.roots);
        const previous = o.previous ? readJsonOr(o.previous, null) : null;
        if (runs.length === 0 && !previous) {
            console.error('collect: no proof runs and no previous proof');
            return 1;
        }
        const proof = collectProof(runs, previous);
        fs.writeFileSync(o.out, JSON.stringify(proof, null, 1) + '\n');
        console.log(printSummary(proof));
        return 0;
    }
    if (command === 'local') {
        const out = path.resolve(o.out || path.join(HERE, 'results', 'proof'));
        const lock = o.lock || defaultLock();
        const jobs = plan({repo: o.repo, fixes: o.fixList});
        for (const job of jobs) {
            const image = `hm-radio-simulator-proof:${job.sha.slice(0, 12)}`;
            const build = withLock(
                lock,
                'docker',
                [
                    'build',
                    '-q',
                    '-f',
                    path.join(HERE, 'docker/Dockerfile'),
                    '--target',
                    'test',
                    '--build-arg',
                    `BASE_REF=${job.sha}`,
                    '--build-arg',
                    `BASE_LABEL=#${job.fix} ${job.side}`,
                    '--build-arg',
                    'DAEMON_VARIANTS=release asan',
                    '-t',
                    image,
                    HERE,
                ],
                {stdio: ['ignore', 'inherit', 'inherit']},
            );
            const record = runSide({
                fix: job.fix,
                side: job.side,
                sha: job.sha,
                image,
                out: path.join(out, `${job.fix}-${job.side}`),
                knownBroken: job.known_broken,
                repeat: job.repeat,
                pattern: job.pattern,
                variants: o.variantList,
                buildFailed: build.status !== 0,
                lock,
            });
            console.log(`#${record.fix} ${record.side}: build ${record.build}`);
        }
        const proof = collectProof(findRuns([out]), readJsonOr(path.join(out, 'proof.json'), null));
        fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify(proof, null, 1) + '\n');
        console.log(printSummary(proof));
        return 0;
    }
    console.error('usage: prove.mjs plan|run|collect|local ... (see the header of scripts/prove.mjs)');
    return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
