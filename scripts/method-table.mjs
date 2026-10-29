#!/usr/bin/env node
/**
 * The RPC dispatcher table of a daemon, read from OpenCCU-Base's own source at image-build time: every
 * `XmlRpcServerMethod("<name>", s)` class that the daemon instantiates - in `InitXmlRpcMethods` (lines that are not
 * commented out) or as a global instance like rfd's `exit` method (`}xmlRpcMethodExit(&s);`). The library's own
 * `system.*` methods are not part of it. The method sweep compares `system.listMethods` against this table, so a
 * method added or removed upstream shows up as a failing test with the name in it.
 *
 * The table honours the preprocessor conditionals around a class (`#ifdef`, `#ifndef`, `#if 0`/`#if 1`, `#else`,
 * `#endif`) for the defines of the build: OpenCCU-Base #258 put rfd's `exit` under `#ifdef DEBUG_SHUTDOWN`, which the
 * build does not define, so `exit` is in the table only where it is compiled in. Undefined: everything not passed with
 * `-D` (so `WIN32` too); any other `#if` expression counts as true.
 *
 * Usage: method-table.mjs [--all] [-D NAME]... <source file>... > table.json
 *   --all  every name defined, registered or not, whatever the conditionals say (the listMethods test's candidates)
 *   -D     a macro the build defines
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** Drops `//` line comments and block comments, keeping string literals intact enough for the patterns below. */
export function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"])\/\/.*$/gm, '$1');
}

/**
 * The source with the lines of the inactive preprocessor branches blanked (the line count stays), for `defines`.
 * @param {string} text
 * @param {Iterable<string>} [defines]
 */
export function preprocess(text, defines = []) {
    const defined = new Set(defines);
    /** @type {{active: boolean, taken: boolean}[]} */
    const stack = [];
    const active = () => stack.every((f) => f.active);
    return text
        .split('\n')
        .map((line) => {
            // the sources have CRLF line ends in places, and `.` does not match \r
            const d = /^\s*#\s*(ifdef|ifndef|if|else|elif|endif)\b\s*(.*)$/.exec(line.replace(/\r$/, ''));
            if (!d) {
                return active() ? line : '';
            }
            const [, kind, rest] = d;
            const arg = rest.replace(/\/\/.*$|\/\*.*$/, '').trim();
            if (kind === 'ifdef' || kind === 'ifndef' || kind === 'if') {
                let on = true;
                if (kind === 'ifdef') {
                    on = defined.has(arg);
                } else if (kind === 'ifndef') {
                    on = !defined.has(arg);
                } else if (/^0+$/.test(arg)) {
                    on = false;
                }
                stack.push({active: on, taken: on});
            } else if (kind === 'else' || kind === 'elif') {
                const top = stack[stack.length - 1];
                if (top) {
                    // an #elif expression is not evaluated: it counts as true when no branch was taken yet
                    top.active = !top.taken;
                    top.taken = true;
                }
            } else {
                stack.pop();
            }
            return '';
        })
        .join('\n');
}

/**
 * Every method name the sources define, registered or not (classes left out of InitXmlRpcMethods, commented-out
 * registrations): the candidates the listMethods test probes for unlisted but callable names.
 * @param {string[]} sources
 * @returns {string[]}
 */
export function allMethodNames(sources) {
    const names = new Set();
    for (const raw of sources) {
        for (const m of raw.matchAll(/XmlRpcServerMethod\(\s*"([^"]+)"/g)) {
            names.add(m[1]);
        }
    }
    return [...names].sort();
}

/**
 * @param {string[]} sources the contents of the daemon's source files (XmlRpcMethods.cpp and the main file)
 * @param {Iterable<string>} [defines] the macros the build defines (preprocess)
 * @returns {string[]} the method names, sorted
 */
export function methodTable(sources, defines = []) {
    const nameOf = new Map();
    const instantiated = new Set();
    for (const raw of sources) {
        const text = preprocess(stripComments(raw), defines);
        // class XmlRpcMethodFoo : public XmlRpcServerMethod { ... XmlRpcServerMethod("foo", s) ...
        const classRe = /class\s+(\w+)\s*:\s*public\s+XmlRpcServerMethod\b/g;
        let m;
        const starts = [];
        while ((m = classRe.exec(text)) !== null) {
            starts.push({name: m[1], at: m.index});
        }
        starts.forEach((c, i) => {
            const body = text.slice(c.at, i + 1 < starts.length ? starts[i + 1].at : text.length);
            const ctor = /XmlRpcServerMethod\(\s*"([^"]+)"/.exec(body);
            if (ctor) {
                nameOf.set(c.name, ctor[1]);
            }
            // a global instance right after the class body: `}xmlRpcMethodExit(&s);`
            if (/\}\s*\w+\s*\(\s*&\s*s\s*\)\s*;/.test(body)) {
                instantiated.add(c.name);
            }
        });
        const init = /void\s+InitXmlRpcMethods\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(text);
        if (init) {
            const instRe = /static\s+(\w+)\s+\w+\s*\(\s*&\s*s\s*\)\s*;/g;
            while ((m = instRe.exec(init[1])) !== null) {
                instantiated.add(m[1]);
            }
        }
    }
    const names = [...instantiated].map((c) => nameOf.get(c)).filter(Boolean);
    return [...new Set(names)].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const all = args[0] === '--all';
    if (all) {
        args.shift();
    }
    const defines = [];
    while (args[0] === '-D' || /^-D\w/.test(args[0] || '')) {
        defines.push(args[0] === '-D' ? args.splice(0, 2)[1] : args.shift().slice(2));
    }
    const files = args;
    if (files.length === 0 || defines.some((d) => !d)) {
        console.error('usage: method-table.mjs [--all] [-D NAME]... <source file>...');
        process.exit(2);
    }
    const sources = files.map((f) => fs.readFileSync(f, 'latin1'));
    const table = all ? allMethodNames(sources) : methodTable(sources, defines);
    if (table.length === 0) {
        console.error(`method-table: no methods found in ${files.join(' ')}`);
        process.exit(1);
    }
    process.stdout.write(JSON.stringify(table, null, 1) + '\n');
}
