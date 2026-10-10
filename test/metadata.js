/**
 * What the report needs to know about the tests: the upstream fixes and findings a test refers to, and the test's
 * kind. The tests themselves carry their references in their names ("#138 on hs485d: ...", "(#115)", "the double-join
 * finding"); this module maps a name to its links and kind, so a test needs no extra wiring and the report script
 * (scripts/report.mjs) stays free of node:test.
 *
 * Kinds:
 *   regression - pins a fixed upstream bug (a PR or commit); runs as todo on refs that predate the fix
 *   known-bug  - a finding of this suite with no upstream fix yet (links to the README's findings until an issue
 *                exists); runs as todo everywhere
 *   behaviour  - a measured daemon behaviour or protocol case
 *   fuzz       - the seeded frame or RPC fuzzing tests (the libFuzzer harnesses are reported separately)
 */

const BASE = 'https://github.com/OpenCCU/OpenCCU-Base';
const README_FINDINGS = 'https://github.com/hobbyquaker/hm-radio-simulator/blob/main/README.en.md#what-it-tests';

/**
 * The OpenCCU-Base pull requests the regression tests pin, with their merge commits (from the GitHub API).
 * @type {Record<number, {title: string, commit: string}>}
 */
export const UPSTREAM_FIXES = Object.freeze({
    9: {
        title: 'Fix signed-char corruption of .dev sysinfo on x86_64 (type byte >= 0x80)',
        commit: '288e258c3c0802cf740a0b1e273960bf3ae816f1',
    },
    13: {title: 'rfd: improve LAN gateway reconnect recovery', commit: '8e815a786280b93cb8cc60a2031eb8c4b425212a'},
    16: {
        title: 'rfd: synchronize LGW controller lifetime during reconnect',
        commit: '2848a5f8f44b8246a09b0eee93203dc7dfde7d2c',
    },
    17: {
        title: 'LAN gateway: fix case-sensitive serial mismatch between connection and status',
        commit: 'bde93606c6c52a3c9dafea65f5abf6c13afc20e4',
    },
    27: {
        title: 'libXmlRpc: preserve dispatcher registration during reconnect failure',
        commit: 'ff6939fdc9815a1944b85464052faf83610165e5',
    },
    112: {
        title: 'eq3_char_loop: hang up slave connections when their master closes',
        commit: '769c9eb0709a5e80c8b1079b9c6ad52a11592e9c',
    },
    115: {
        title: 'rfd: do not crash on read errors of the serial device',
        commit: 'e370dcbdb6ecc94d2555965be72e754dc74c4f5b',
    },
    116: {
        title: 'rfd: report a serial device with a persistent read error as not connected',
        commit: '0cb30cb7b459402129233188ccbfc296f6e05d5a',
    },
    138: {
        title: 'libXmlRpc: fix stack overflow (SIGSEGV) on nested system.multicall',
        commit: '0d71a252d1d3c0b9ddd77410cc3db2e864c1e6ec',
    },
    140: {
        title: 'libXmlRpc: bound-check the length fields of the BIN-RPC deserializer',
        commit: '478d18477b42a35bf4fddaa4a2e8e22b6db6d00a',
    },
});

/**
 * Findings of this suite without an upstream issue yet. When an issue exists, put its URL here.
 * @type {Record<string, {title: string, issue: string|null}>}
 */
export const FINDINGS = Object.freeze({
    'double-join': {
        title: 'rfd aborts under ASan on init(url, ""): the receiver dispatcher thread is joined twice (libelvutils Actor::Stop())',
        issue: null,
    },
    'read-eof': {
        title: 'rfd on main spins at 100 % and keeps CONNECTED after a pty hangup: read() == 0 is not treated as an error (#115/#116)',
        issue: null,
    },
});

/**
 * @typedef {{label: string, url: string, kind: 'pr'|'commit'|'issue'|'readme'}} Ref
 */

/**
 * @param {number} number an OpenCCU-Base pull request number
 * @returns {Ref[]}
 */
export function refsForPullRequest(number) {
    const fix = UPSTREAM_FIXES[number];
    const refs = [{label: `OpenCCU-Base #${number}`, url: `${BASE}/pull/${number}`, kind: 'pr'}];
    if (fix) {
        refs.push({label: fix.commit.slice(0, 7), url: `${BASE}/commit/${fix.commit}`, kind: 'commit'});
    }
    return refs;
}

/**
 * @param {string} name a finding's name
 * @returns {Ref[]}
 */
export function refsForFinding(name) {
    const finding = FINDINGS[name];
    if (finding && finding.issue) {
        return [{label: `${name} (issue)`, url: finding.issue, kind: 'issue'}];
    }
    return [{label: `${name} (README)`, url: README_FINDINGS, kind: 'readme'}];
}

/**
 * The references and the kind of a test, from its name.
 * @param {string} name the test's name as node:test reports it
 * @param {{todo?: boolean|string}} [result]
 * @returns {{kind: 'regression'|'known-bug'|'behaviour'|'fuzz', refs: Ref[]}}
 */
export function describeTest(name, result = {}) {
    const refs = [];
    const seen = new Set();
    // a subtest's own name may carry no number; its todo reason ("OpenCCU-Base #115 is not fixed ...") does
    const todoText = typeof result.todo === 'string' ? result.todo : '';
    for (const m of `${name} ${todoText}`.matchAll(/#(\d+)/g)) {
        const number = Number(m[1]);
        if (!seen.has(number)) {
            seen.add(number);
            refs.push(...refsForPullRequest(number));
        }
    }
    let kind = 'behaviour';
    for (const finding of Object.keys(FINDINGS)) {
        if (name.includes(finding)) {
            refs.push(...refsForFinding(finding));
            kind = 'known-bug';
        }
    }
    for (const finding of Object.keys(FINDINGS)) {
        if (todoText.includes(`the ${finding} finding`) && !refs.some((r) => r.label.startsWith(finding))) {
            refs.push(...refsForFinding(finding));
            kind = 'known-bug';
        }
    }
    if (kind === 'behaviour' && seen.size > 0) {
        kind = 'regression';
    }
    if (kind === 'behaviour' && /fuzz/i.test(name)) {
        kind = 'fuzz';
    }
    return {kind, refs};
}
