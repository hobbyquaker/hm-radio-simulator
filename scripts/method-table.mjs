#!/usr/bin/env node
/**
 * The RPC dispatcher table of a daemon, read from OpenCCU-Base's own source at image-build time: every
 * `XmlRpcServerMethod("<name>", s)` class that the daemon instantiates - in `InitXmlRpcMethods` (lines that are not
 * commented out) or as a global instance like rfd's `exit` method (`}xmlRpcMethodExit(&s);`). The library's own
 * `system.*` methods are not part of it. The method sweep compares `system.listMethods` against this table, so a
 * method added or removed upstream shows up as a failing test with the name in it.
 *
 * Usage: method-table.mjs <source file>... > table.json
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** Drops `//` line comments and block comments, keeping string literals intact enough for the patterns below. */
export function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"])\/\/.*$/gm, '$1');
}

/**
 * @param {string[]} sources the contents of the daemon's source files (XmlRpcMethods.cpp and the main file)
 * @returns {string[]} the method names, sorted
 */
export function methodTable(sources) {
    const nameOf = new Map();
    const instantiated = new Set();
    for (const raw of sources) {
        const text = stripComments(raw);
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
    const files = process.argv.slice(2);
    if (files.length === 0) {
        console.error('usage: method-table.mjs <source file>...');
        process.exit(2);
    }
    const table = methodTable(files.map((f) => fs.readFileSync(f, 'latin1')));
    if (table.length === 0) {
        console.error(`method-table: no methods found in ${files.join(' ')}`);
        process.exit(1);
    }
    process.stdout.write(JSON.stringify(table, null, 1) + '\n');
}
