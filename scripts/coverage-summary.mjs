#!/usr/bin/env node
/**
 * Summarises an lcov tracefile per component: the daemons' own sources (src/rfd, src/hs485d) and the libraries
 * (src/libXmlRpc, src/libxmlparser, src/libelvutils, src/libUnifiedLanComm, ...) as their own rows, so a daemon's
 * percentage is neither diluted nor inflated by the libraries; plus the per-file percentages. No source text.
 *
 *   coverage-summary.mjs <coverage.info>   prints the summary as JSON
 */

import fs from 'node:fs';

/**
 * @param {string} text an lcov tracefile
 * @returns {{files: Array<{file: string, lines: [number, number], functions: [number, number], branches: [number, number]}>}}
 */
export function parseLcov(text) {
    const files = [];
    let current = null;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('SF:')) {
            current = {file: line.slice(3), lines: [0, 0], functions: [0, 0], branches: [0, 0]};
        } else if (!current) {
            continue;
        } else if (line.startsWith('LF:')) {
            current.lines[1] = Number(line.slice(3));
        } else if (line.startsWith('LH:')) {
            current.lines[0] = Number(line.slice(3));
        } else if (line.startsWith('FNF:')) {
            current.functions[1] = Number(line.slice(4));
        } else if (line.startsWith('FNH:')) {
            current.functions[0] = Number(line.slice(4));
        } else if (line.startsWith('BRF:')) {
            current.branches[1] = Number(line.slice(4));
        } else if (line.startsWith('BRH:')) {
            current.branches[0] = Number(line.slice(4));
        } else if (line === 'end_of_record') {
            files.push(current);
            current = null;
        }
    }
    return {files};
}

/**
 * The component a source file belongs to: the directory under src/ (rfd, hs485d, libXmlRpc, ...), or "other".
 * @param {string} file
 */
export function componentOf(file) {
    const m = /\/src\/([^/]+)\//.exec(file);
    if (!m) {
        return 'other';
    }
    return m[1];
}

function pct(hit, total) {
    return total ? Math.round((hit / total) * 1000) / 10 : null;
}

/**
 * @param {ReturnType<typeof parseLcov>} parsed
 */
export function summarise(parsed) {
    const components = new Map();
    for (const f of parsed.files) {
        const name = componentOf(f.file);
        if (!components.has(name)) {
            components.set(name, {component: name, lines: [0, 0], functions: [0, 0], branches: [0, 0], files: []});
        }
        const c = components.get(name);
        for (const k of ['lines', 'functions', 'branches']) {
            c[k][0] += f[k][0];
            c[k][1] += f[k][1];
        }
        c.files.push({
            file: f.file.replace(/^.*\/src\//, 'src/'),
            lines: pct(f.lines[0], f.lines[1]),
            linesHit: f.lines[0],
            linesTotal: f.lines[1],
            functions: pct(f.functions[0], f.functions[1]),
            branches: pct(f.branches[0], f.branches[1]),
        });
    }
    const order = (name) => (name === 'rfd' ? 0 : name === 'hs485d' ? 1 : name === 'other' ? 3 : 2);
    const rows = [...components.values()]
        .sort((a, b) => order(a.component) - order(b.component) || a.component.localeCompare(b.component))
        .map((c) => ({
            component: c.component,
            kind: c.component === 'rfd' || c.component === 'hs485d' ? 'daemon' : 'library',
            lines: pct(c.lines[0], c.lines[1]),
            linesHit: c.lines[0],
            linesTotal: c.lines[1],
            functions: pct(c.functions[0], c.functions[1]),
            functionsHit: c.functions[0],
            functionsTotal: c.functions[1],
            branches: pct(c.branches[0], c.branches[1]),
            branchesHit: c.branches[0],
            branchesTotal: c.branches[1],
            files: c.files.sort((a, b) => a.file.localeCompare(b.file)),
        }));
    return {generatedAt: new Date().toISOString(), components: rows};
}

if (process.argv[1] && process.argv[1].endsWith('coverage-summary.mjs')) {
    const file = process.argv[2];
    if (!file) {
        console.error('usage: coverage-summary.mjs <coverage.info>');
        process.exit(2);
    }
    process.stdout.write(JSON.stringify(summarise(parseLcov(fs.readFileSync(file, 'utf8'))), null, 1) + '\n');
}
