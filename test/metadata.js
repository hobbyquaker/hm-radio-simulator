/**
 * What the report needs to know about the tests: the upstream fixes and findings a test refers to, and the test's
 * kind. The tests themselves carry their references in their names ("#138 on hs485d: ...", "(#115)", "the double-join
 * finding"); this module maps a name to its links and kind, so a test needs no extra wiring and the report script
 * (scripts/report.mjs) stays free of node:test.
 *
 * Kinds:
 *   regression - pins a fixed upstream bug (a PR or commit); runs as todo on refs that predate the fix
 *   known-bug  - a finding of this suite with no upstream fix yet (links to its issue draft in upstream-reports/
 *                until an issue exists); runs as todo everywhere
 *   behaviour  - a measured daemon behaviour or protocol case
 *   fuzz       - the seeded frame or RPC fuzzing tests (the libFuzzer harnesses are reported separately)
 */

const BASE = 'https://github.com/OpenCCU/OpenCCU-Base';
/** The fork that carries fixes before they are upstream (openccu-lite builds from its branch lite and tags each build). */
export const FORK_REPO = 'https://github.com/hobbyquaker/OpenCCU-Base.git';
const FORK = FORK_REPO.replace(/\.git$/, '');
const UPSTREAM_REPORTS = 'https://github.com/hobbyquaker/hm-radio-simulator/blob/main/upstream-reports';

/**
 * The OpenCCU-Base pull requests the regression tests pin, with their merge commits (from the GitHub API). Every entry
 * needs at least one daemon test whose top-level name carries its number ("#138: ...", "(#9 shape)") and that uses
 * `regression(<number>)` (test/unit/prove.test.js checks both): scripts/prove.mjs selects a fix's tests by that
 * name and runs them on the merge commit's parent, where they must fail, and on the merge commit, where they must pass.
 *
 * `proofRepeat`: how often the proof runs the tests on the parent under ASan before it calls the fix "not proven" - for
 * races and lifetime bugs, which a single run may miss (default 1).
 * `proofVariants`: the daemon variants the proof runs (default release and asan, scripts/prove.mjs PROOF_VARIANTS);
 * with `tsan` the fix is also judged by ThreadSanitizer's reports - a race signature the parent reports and the merge
 * commit does not is the fix's proof (`provenBy: 'sanitizer'`).
 *
 * Not listed: #112 (eq3_char_loop, 769c9eb0) and #22 - eq3_char_loop and multimacd are stage 5 (multimacd in a VM);
 * they join this list with their tests.
 * @type {Record<number, {title: string, commit: string, proofRepeat?: number, proofVariants?: string[]}>}
 */
export const UPSTREAM_FIXES = Object.freeze({
    4: {
        title: 'fixes compiler error and AES (CBC-MAC without PKCS7 padding; merged via #8)',
        commit: '8ecd25e953321e1604c5cf309f9adfd2616b10fc',
    },
    9: {
        title: 'Fix signed-char corruption of .dev sysinfo on x86_64 (type byte >= 0x80)',
        commit: '288e258c3c0802cf740a0b1e273960bf3ae816f1',
    },
    13: {title: 'rfd: improve LAN gateway reconnect recovery', commit: '8e815a786280b93cb8cc60a2031eb8c4b425212a'},
    16: {
        title: 'rfd: synchronize LGW controller lifetime during reconnect',
        commit: '2848a5f8f44b8246a09b0eee93203dc7dfde7d2c',
        proofRepeat: 5,
        proofVariants: ['release', 'asan', 'tsan'],
    },
    17: {
        title: 'LAN gateway: fix case-sensitive serial mismatch between connection and status',
        commit: 'bde93606c6c52a3c9dafea65f5abf6c13afc20e4',
    },
    27: {
        title: 'libXmlRpc: preserve dispatcher registration during reconnect failure',
        commit: 'ff6939fdc9815a1944b85464052faf83610165e5',
        proofRepeat: 5,
    },
    63: {title: 'rftypes: migrate patch 0003 CFM-TW fix', commit: '661be9e8829a2404a89f0b64c72f7283cb72dbc4'},
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
 * OpenCCU-Base fixes without a pull request, older than every ref the suite builds (and mostly than its CMake build):
 * their tests (test/daemon/older-fixes.test.js) carry the short commit in the name ("(c57eb49f)"), never run as todo
 * and cannot be proven on the parent (scripts/prove.mjs needs a CMake build).
 * @type {Record<string, {title: string, commit: string}>}
 */
export const UPSTREAM_COMMITS = Object.freeze({
    c57eb49f: {
        title: 'hs485d: hex instead of decimal device addresses and serials (PRIX32)',
        commit: 'c57eb49f8a429106a5b9203d7287342b31c9fd37',
    },
    bf7851d1: {
        title: 'hs485d: string search results in std::string::size_type instead of unsigned int',
        commit: 'bf7851d1325a6bbbea03aa5affcda9d333f9d1a3',
    },
    fc83bfd4: {
        title: 'libXmlRpc: workarounds for lazy XML-RPC servers',
        commit: 'fc83bfd4ae756f2c0b9380428634f3e318530984',
    },
    '90c666c0': {
        title: 'libXmlRpc: clock_gettime() and 64-bit millisecond times (Y2036)',
        commit: '90c666c0eb87ce2e6e3f1888fd4d9a67ff6eb298',
    },
});

/**
 * Findings of this suite, each with its issue draft in upstream-reports/ (not reported yet; the maintainer decides).
 * When an issue exists, put its URL into `issue` and the draft's status line.
 * `fuzzHarness`: the libFuzzer harness that finds it (its findings are then known, not new, on refs without the fix).
 *
 * A fix decides where the finding is known broken (scripts/refs.mjs knownBroken): a ref that contains the fix - as an
 * ancestor, or picked onto it (`cherry picked from commit <sha>` or the same patch id, scripts/history.mjs) - runs the
 * finding's tests for real.
 *   `fork`     the fix on the fork FORK_REPO before it is upstream: `commit` is the commit on the fix branch `branch`
 *              (the pull request candidate); the fork's branches pick it with `cherry-pick -x`
 *   `fixedBy`  the upstream commit that fixes it - for a fork fix, add the merge commit when upstream merges the pull
 *              request; nothing else changes
 * A finding with a fork fix and an issue joins the proof under its issue number (scripts/prove.mjs): its tests' names
 * carry `#<issue>`.
 * `signatures`: a data race ThreadSanitizer reports (the tsan variant): regular expressions over the SUMMARY lines of
 * its reports. On a ref known to lack the fix, Daemon.sanitizerReports() leaves reports out whose summaries all match a
 * known finding's signatures (knownSanitizerReports() has them), so the tests that insist on "no sanitizer report"
 * keep passing under tsan until a new race appears - which then fails them, as it should.
 * @type {Record<string, {title: string, draft: string, issue: string|null, fuzzHarness?: string, fixedBy?: string,
 *   fork?: {commit: string, branch: string}, proofRepeat?: number, signatures?: RegExp[]}>}
 */
export const FINDINGS = Object.freeze({
    'ulc-data-races': {
        title: "libUnifiedLanComm: the connection state, the receive thread's stop and the hello handling race between the receive thread and the caller (ThreadSanitizer; rfd's HM-LGW and hs485d's HMW-LGW path)",
        draft: '024-ulc-data-races.md',
        issue: null,
        signatures: [
            /ulc::UnifiedLanCommController::(stopReceiveThread|handleHelloMessage|waitForState|~UnifiedLanCommController|disconnect|connect)\(/,
            /ulc::LanConnection::(disconnect|connect|waitForData|receive|send)\(/,
        ],
    },
    'copro-request-races': {
        title: 'rfd: the coprocessor request slot (CCU2CommController RequestInfo, the command copied into it) is written by the serial receive thread and read by the waiting caller outside the lock, and handleIncomingResponse locks a mutex twice (ThreadSanitizer; the area of the system-command-slot finding, #179)',
        draft: '026-copro-request-races.md',
        issue: null,
        signatures: [
            /HM2::CCU2CommController::(waitForCoProcessorResponse|sendSystemCommand|sendBidcosRequest|internalSendBidcosRequest|sendBidcosTelegram|handleIncomingResponse|handleIncomingSerialFrame|handleIdentifyEvent)\(/,
            /HM2::CCU2CoprocessorCommand::(operator=|CCU2CoprocessorCommand)\(/,
        ],
    },
    'lgw-wrapper-races': {
        title: "rfd's and hs485d's LGWPortWrapper: the last-communication timestamp, the keepalive thread's stop flag and the reconnect state are plain variables written by one thread and read by another (ThreadSanitizer)",
        draft: '025-lgw-wrapper-races.md',
        issue: null,
        signatures: [/LGWPortWrapper::(ReadData|SendData|reconnect|\w*KeepAlive\w*)\(/],
    },
    'double-join': {
        title: 'rfd aborts under ASan on init(url, ""): the receiver dispatcher thread is joined twice (libelvutils Actor::Stop())',
        draft: '001-double-join.md',
        issue: null,
    },
    'read-eof': {
        title: 'rfd on main spins at 100 % and keeps CONNECTED after a pty hangup: read() == 0 is not treated as an error (#115/#116)',
        draft: '002-read-eof.md',
        issue: null,
    },
    'aes-republish': {
        title: 'rfd does not restore the per-channel AES policy (AUTHENTICATION_ON) when it republishes devices after a coprocessor re-init',
        draft: '005-aes-policy-after-reinit.md',
        issue: 'https://github.com/OpenCCU/OpenCCU-Base/issues/165',
        fork: {commit: '800f1312692b18ff93f02d41ec89b667c97d82eb', branch: 'fix/165-aes-republish'},
    },
    'wired-maintenance': {
        title: 'hs485d: a newly discovered wired device gets plain channels - its maintenance channel (UNREACH, STICKY_UNREACH, CONFIG_PENDING) works only after a restart',
        draft: '006-wired-maintenance-channel.md',
        issue: null,
    },
    'metadata-args': {
        title: 'rfd: setVolatileMetadata (and getMetadata/setMetadata) with a missing argument read freed memory - the second index reallocates the parameter array under the first string',
        draft: '007-metadata-missing-argument.md',
        issue: null,
    },
    'string-uint-conversion': {
        title: 'libhsscomm: type_conversion_string_unsigned_integer reads a destroyed temporary string (HM-OU-LED16 channel set-up)',
        draft: '008-string-uint-conversion-dangling.md',
        issue: null,
    },
    'replace-callback': {
        title: 'rfd and hs485d: a receiver that registers after a device was replaced gets deleteDevices instead of replaceDevice (rfd IsDeviceReplaced() always false; hs485d stores the new serial in the history)',
        draft: '009-replace-callback.md',
        issue: null,
    },
    'init-blocks': {
        title: 'rfd and hs485d: init with a receiver that does not answer freezes the whole daemon - the init callbacks run without a timeout on the main loop',
        draft: '010-init-blocks-main-loop.md',
        issue: 'https://github.com/OpenCCU/OpenCCU-Base/issues/170',
        fork: {commit: '751cd79f787261ca06d9a3b87b244f8f13bc10ae', branch: 'fix/170-init-timeout'},
    },
    'async-callback-threads': {
        title: 'rfd and hs485d: every unanswered newDevices/deleteDevices/replaceDevice leaves a thread and a socket behind for good',
        draft: '011-async-callback-threads.md',
        issue: 'https://github.com/OpenCCU/OpenCCU-Base/issues/171',
        fork: {commit: '05af7256bbdf154a697c3d878454becc84c41bd3', branch: 'fix/171-async-timeout'},
    },
    'dutycycle-upper-bound': {
        title: 'rfd reads past its duty-cycle threshold map when the module reports 100 % (BidcosInterface::GetDutyCycleUpperBound)',
        draft: '012-dutycycle-upper-bound.md',
        issue: null,
    },
    'flush-drops-events': {
        title: 'rfd discards unread events from the radio module before every command it sends (tcflush TCIFLUSH in SendData)',
        draft: '013-flush-drops-events.md',
        issue: null,
    },
    'unknown-interface': {
        title: 'rfd: setBidcosInterface accepts an interface that does not exist, reports success and stores it',
        draft: '014-unknown-interface.md',
        issue: null,
    },
    'json-substr': {
        title: 'rfd terminates on setValue with a malformed JSON value for a parameter with write dependencies (JSONObject throws std::out_of_range)',
        draft: '015-json-substr.md',
        issue: null,
        fuzzHarness: 'fuzz_json',
    },
    'hexfile-no-data': {
        title: 'libelvutils Hexfile::Read erases from begin() to begin() - 1 for a hex file without a data record (hs485d firmware files)',
        draft: '016-hexfile-no-data.md',
        issue: null,
        fuzzHarness: 'fuzz_hexfile',
    },
    'propertymap-long-line': {
        title: 'libelvutils PropertyMap::ReadFromFile loops for ever on a line longer than 255 characters (rfd and hs485d hang at start-up)',
        draft: '017-propertymap-long-line.md',
        issue: null,
        fuzzHarness: 'fuzz_propertymap',
    },
    'xmlrpc-select-fd': {
        title: 'libXmlRpc: the RPC server stops answering once its sockets have descriptors of 1024 or more (select() with fd_set)',
        draft: '018-xmlrpc-select-fd.md',
        issue: null,
    },
    'system-command-slot': {
        title: "rfd: two coprocessor system commands from two threads share one request slot; one takes the other's answer",
        draft: '019-system-command-slot.md',
        issue: null,
    },
    'ack-rssi-sign': {
        title: "rfd: the RSSI byte in the module's send status (the ACK) is signed; rfd negates it like the event's magnitude",
        draft: '020-ack-rssi-signed.md',
        issue: null,
    },
    'update-nack-ignored': {
        title: "rfd: a device's NACK to a firmware update frame counts as delivered - the update ends as a success and the device is rebuilt with the new version (BidcosInterfaceConcentrator::SendUpdataFrame never checks the response)",
        draft: '021-update-nack-ignored.md',
        issue: null,
    },
    'info-blank-line': {
        title: 'rfd terminates on a blank line in a user firmware info file: RFFirmwareManager::TrimLine runs its unsigned loop index below zero (std::out_of_range, uncaught)',
        draft: '022-info-blank-line.md',
        issue: null,
    },
    'bootloader-pagesize-zero': {
        title: "hs485d dies with SIGFPE when a wired device's bootloader answers the page-size request with 0 (HS485Device::WriteFlash divides by it)",
        draft: '023-bootloader-pagesize-zero.md',
        issue: null,
    },
    'exit-rpc': {
        title: 'the RPC method exit is always compiled into rfd: any client can stop it',
        draft: '003-exit-rpc-method.md',
        issue: null,
    },
    'no-sigterm': {
        title: 'rfd and hs485d do not handle SIGTERM: a pending save is lost on stop',
        draft: '004-no-sigterm-handling.md',
        issue: 'https://github.com/OpenCCU/OpenCCU-Base/issues/164',
        fork: {commit: '2386c07aca3c5763336b62ba2c582bd38f5e815c', branch: 'fix/164-sigterm'},
    },
});

/**
 * @typedef {{label: string, url: string, kind: 'pr'|'commit'|'issue'|'draft'}} Ref
 */

/** The number of an issue URL (`…/issues/164` -> 164), or null. */
export function issueNumber(url) {
    const m = /\/issues\/(\d+)$/.exec(url || '');
    return m ? Number(m[1]) : null;
}

/** The finding whose issue has this number, or null. */
export function findingOfIssue(number) {
    const hit = Object.entries(FINDINGS).find(([, f]) => issueNumber(f.issue) === Number(number));
    return hit ? hit[0] : null;
}

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
 * @param {string} short a key of UPSTREAM_COMMITS
 * @returns {Ref[]}
 */
export function refsForCommit(short) {
    const fix = UPSTREAM_COMMITS[short];
    return fix ? [{label: `OpenCCU-Base ${short}`, url: `${BASE}/commit/${fix.commit}`, kind: 'commit'}] : [];
}

/**
 * @param {string} name a finding's name
 * @returns {Ref[]}
 */
export function refsForFinding(name) {
    const finding = FINDINGS[name];
    if (finding && finding.issue) {
        const refs = [{label: `${name} (issue)`, url: finding.issue, kind: 'issue'}];
        if (finding.fixedBy) {
            refs.push({label: finding.fixedBy.slice(0, 7), url: `${BASE}/commit/${finding.fixedBy}`, kind: 'commit'});
        } else if (finding.fork) {
            refs.push({
                label: `fork ${finding.fork.commit.slice(0, 7)}`,
                url: `${FORK}/commit/${finding.fork.commit}`,
                kind: 'commit',
            });
        }
        return refs;
    }
    if (finding) {
        return [{label: `${name} (draft)`, url: `${UPSTREAM_REPORTS}/${finding.draft}`, kind: 'draft'}];
    }
    return [{label: `${name} (drafts)`, url: UPSTREAM_REPORTS, kind: 'draft'}];
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
            // an issue number of a finding (a fix on the fork, "#164 SIGTERM: ...") links the issue, not a pull request
            const finding = findingOfIssue(number);
            refs.push(...(finding ? refsForFinding(finding) : refsForPullRequest(number)));
        }
    }
    for (const m of name.matchAll(/\b([0-9a-f]{8})\b/g)) {
        if (UPSTREAM_COMMITS[m[1]] && !seen.has(m[1])) {
            seen.add(m[1]);
            refs.push(...refsForCommit(m[1]));
        }
    }
    let kind = 'behaviour';
    for (const finding of Object.keys(FINDINGS)) {
        if (name.includes(finding)) {
            if (!refs.some((r) => r.label.startsWith(`${finding} `))) {
                refs.push(...refsForFinding(finding));
            }
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
