#!/usr/bin/env node
/**
 * Writes fuzz-summary.json for the report from a fuzz run's results directory: per harness the libFuzzer final stats
 * (executions, executions per second) from <harness>.log and the findings from artifacts/<harness>/ (crash-, timeout-,
 * oom-, leak- files) with the sanitizer's error type from the log.
 *
 * Usage: fuzz-summary.mjs <results dir> <ref> <base commit> <seconds> <expected: 0|1> <harness>...
 * FUZZ_KNOWN_HARNESSES (harness=finding,...) marks harnesses whose findings are a known finding of this suite.
 */

import fs from 'node:fs';
import path from 'node:path';

const [dir, ref, baseCommit, seconds, expected, ...harnesses] = process.argv.slice(2);
if (!dir || !ref || harnesses.length === 0) {
    console.error('usage: fuzz-summary.mjs <results dir> <ref> <base commit> <seconds> <expected> <harness>...');
    process.exit(2);
}

function stat(log, name) {
    const m = new RegExp(`stat::${name}:\\s*(\\d+)`).exec(log);
    return m ? Number(m[1]) : null;
}

function errorType(log) {
    const patterns = [
        /ERROR: (AddressSanitizer|UndefinedBehaviorSanitizer|LeakSanitizer|MemorySanitizer): ([a-zA-Z0-9_-]+)/,
        /ERROR: libFuzzer: (out-of-memory|timeout|deadly signal|fuzz target exited)/,
        /runtime error: ([^\n]{0,80})/,
    ];
    for (const p of patterns) {
        const m = p.exec(log);
        if (m) {
            return m[2] ? `${m[1]}: ${m[2]}` : m[1];
        }
    }
    return null;
}

const known = Object.fromEntries(
    (process.env.FUZZ_KNOWN_HARNESSES || '')
        .split(',')
        .filter((s) => s.includes('='))
        .map((s) => s.split('=')),
);

const summary = {
    ref,
    baseCommit,
    seconds: Number(seconds),
    expected: expected === '1',
    status: 'clean',
    harnesses: [],
};
for (const name of harnesses) {
    const logFile = path.join(dir, `${name}.log`);
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const artifactDir = path.join(dir, 'artifacts', name);
    const findings = [];
    if (fs.existsSync(artifactDir)) {
        for (const file of fs.readdirSync(artifactDir).sort()) {
            const kind = /^(crash|timeout|oom|leak)-/.exec(file);
            if (kind) {
                findings.push({file, kind: kind[1], type: errorType(log) || kind[1]});
            }
        }
    }
    const statusFile = path.join(dir, `${name}.status`);
    const status = fs.existsSync(statusFile) ? Number(fs.readFileSync(statusFile, 'utf8').trim()) : null;
    summary.harnesses.push({
        name,
        seconds: Number(seconds),
        status,
        execs: stat(log, 'number_of_executed_units'),
        execPerSec: stat(log, 'average_exec_per_sec'),
        findings,
        known: known[name] || null,
    });
    if (!known[name] && (findings.length || (status !== null && status !== 0))) {
        summary.status = 'findings';
    }
}
fs.writeFileSync(path.join(dir, 'fuzz-summary.json'), JSON.stringify(summary, null, 1) + '\n');
console.log(
    `fuzz-summary.json: ${summary.status}, ${summary.harnesses.map((h) => `${h.name} ${h.execs ?? '?'} execs, ${h.findings.length} findings`).join('; ')}`,
);
