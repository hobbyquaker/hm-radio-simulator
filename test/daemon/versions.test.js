/**
 * The versions the daemons report about themselves. Since OpenCCU-Base #294, rfd and hs485d take `-v` and `--version`
 * as their only argument: they print `<name> <version> (<build date>)` - the version from the daemon's `version.sh`,
 * which the image keeps next to the dispatcher sources - and one line per OpenCCU-Base library they call, read from the
 * loaded library, and exit 0 without starting. Before #294 the option was unknown and the daemon started.
 *
 * Timing assumption: printing the version takes milliseconds; the daemon gets 10 s before it counts as started (a ref
 * without #294), then it is killed.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {DAEMONS, skipWithoutDaemons} from '../helpers/daemon.js';
import {regression} from '../helpers/known.js';

const SOURCES = process.env.HMRS_METHODS_SRC || '/opt/openccu-base/methods-src';
/** The libraries both daemons list (rfd.cpp and hs485d.cpp, printVersion()). */
const LIBRARIES = ['libXmlRpc', 'libxmlparser', 'libhsscomm', 'libelvutils', 'libLanDeviceUtils', 'libUnifiedLanComm'];

/** Runs `bin` with `args`; the output and the exit, or `started: true` when it was still running after 10 s. */
function run(bin, args) {
    return new Promise((resolve) => {
        const child = spawn(bin, args, {
            cwd: fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'hmrs-version-')),
            env: {
                ...process.env,
                LD_LIBRARY_PATH: path.join(DAEMONS, 'lib'),
                ASAN_OPTIONS: 'detect_leaks=0',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({out, started: true});
        }, 10000);
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({out, code, signal, started: false});
        });
    });
}

for (const daemon of ['rfd', 'hs485d']) {
    test(
        `#294: ${daemon} -v and --version print its version from version.sh and the versions of its libraries, and exit 0`,
        {...skipWithoutDaemons, ...regression(294), timeout: 60000},
        async (t) => {
            const script = path.join(SOURCES, daemon, 'version.sh');
            if (!fs.existsSync(script)) {
                t.skip(`no ${script} in this image`);
                return;
            }
            const version = execFileSync('sh', [script], {encoding: 'utf8'}).trim();
            for (const option of ['-v', '--version']) {
                const result = await run(path.join(DAEMONS, 'bin', daemon), [option]);
                t.diagnostic(`${daemon} ${option}: ${JSON.stringify(result)}`);
                assert.equal(result.started, false, `${daemon} ${option} ended at once`);
                assert.equal(result.code, 0, `exit 0\n${result.out}`);
                const lines = result.out.trim().split('\n');
                assert.match(lines[0], new RegExp(`^${daemon} ${version.replace(/\./g, '\\.')} \\(`), 'the first line');
                for (const library of LIBRARIES) {
                    assert.ok(
                        lines.some((l) => new RegExp(`^\\s+${library} \\d+\\.\\d+(\\.\\d+)?$`).test(l)),
                        `a line for ${library}\n${result.out}`,
                    );
                }
            }
        },
    );
}
