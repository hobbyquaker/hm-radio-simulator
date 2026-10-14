import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {FINDINGS, RELEVANCE, UPSTREAM_COMMITS, describeTest, relevanceOf} from '../metadata.js';

test('a test named with a short commit of UPSTREAM_COMMITS is a regression test linking that commit', () => {
    const {kind, refs} = describeTest(
        'hs485d: a device without a serial is named ELV and its address in hex (c57eb49f)',
    );
    assert.equal(kind, 'regression');
    assert.deepEqual(refs, [
        {
            label: 'OpenCCU-Base c57eb49f',
            url: `https://github.com/OpenCCU/OpenCCU-Base/commit/${UPSTREAM_COMMITS.c57eb49f.commit}`,
            kind: 'commit',
        },
    ]);
    assert.equal(describeTest('a test about deadbeef').kind, 'behaviour');
    for (const [short, fix] of Object.entries(UPSTREAM_COMMITS)) {
        assert.ok(fix.commit.startsWith(short), short);
    }
});

// the field-relevance research of 2026-10-14 (task 42): the class of every finding it covered
const RESEARCH = {
    'ack-rssi-sign': 'field', // #185: every ACK on an RPI-RF-MOD
    'wired-maintenance': 'field', // #166: every wired installation, until hs485d's next restart
    'lgw-wrapper-races': 'rare', // #195, the hs485d part; the rfd part is harmless
    'lgw-reconnect-uaf': 'rare', // #195: the hs485d part's use-after-free, its own finding for the fork fix
    'devices-lock-wait': 'rare', // 027
    'system-command-slot': 'rare', // #179
    'json-substr': 'rare', // #175
    'double-join': 'edge', // #161
    'exit-rpc': 'edge', // #163
    'metadata-args': 'edge', // #167
    'string-uint-conversion': 'edge', // #168
    'replace-callback': 'edge', // #169
    'dutycycle-upper-bound': 'edge', // #172
    'unknown-interface': 'edge', // #174
    'hexfile-no-data': 'edge', // #176
    'propertymap-long-line': 'edge', // #177
    'xmlrpc-select-fd': 'edge', // #178
    'update-nack-ignored': 'edge', // 021
    'info-blank-line': 'edge', // 022
    'bootloader-pagesize-zero': 'edge', // 023
    'ulc-data-races': 'edge', // 024
    'copro-request-races': 'edge', // 026
};

test('every finding the field-relevance research covered carries its class and a reason; the others none', () => {
    for (const [name, finding] of Object.entries(FINDINGS)) {
        if (RESEARCH[name]) {
            assert.equal(finding.relevance, RESEARCH[name], name);
            assert.ok(RELEVANCE[finding.relevance], name);
            assert.ok(finding.relevanceNote && finding.relevanceNote.length > 20, `${name}: relevanceNote`);
        } else {
            assert.equal(finding.relevance, undefined, `${name} was not covered by the research`);
            assert.equal(finding.relevanceNote, undefined, name);
        }
    }
    for (const name of Object.keys(RESEARCH)) {
        assert.ok(FINDINGS[name], `${name} is a finding`);
    }
    assert.deepEqual(Object.keys(RELEVANCE), ['field', 'rare', 'edge'], 'most relevant first');
    for (const r of Object.values(RELEVANCE)) {
        assert.ok(r.label && r.de && r.text);
    }
});

test("a draft's front matter carries its finding's relevance class (or none when the finding is unclassified)", () => {
    const dir = new URL('../../upstream-reports/', import.meta.url);
    for (const finding of Object.values(FINDINGS)) {
        const text = fs.readFileSync(new URL(finding.draft, dir), 'utf8');
        const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
        assert.ok(front, `${finding.draft}: front matter`);
        const m = /^relevance: (\w+)/m.exec(front[1]);
        assert.equal(m ? m[1] : undefined, finding.relevance, finding.draft);
    }
});

test("describeTest: a test of a finding carries the finding's relevance - by its name or its todo reason", () => {
    const byName = describeTest('rfd and hs485d with a long config line (the propertymap-long-line finding)');
    assert.equal(byName.relevance.relevance, 'edge');
    assert.deepEqual(byName.relevance.findings, ['propertymap-long-line']);
    assert.equal(byName.relevance.note, FINDINGS['propertymap-long-line'].relevanceNote);
    const viaTodo = describeTest('the ACK of a switch', {todo: 'the ack-rssi-sign finding is not fixed on this ref'});
    assert.equal(viaTodo.relevance.relevance, 'field');
    // the most relevant class wins when a test names two findings
    const two = describeTest('json-substr and double-join in one test');
    assert.equal(two.relevance.relevance, 'rare');
    assert.deepEqual(two.relevance.findings, ['json-substr']);
    // no finding, or an unclassified one: null
    assert.equal(describeTest('rfd initialises the simulated module').relevance, null);
    assert.equal(describeTest('#138 on hs485d: a nested system.multicall is refused').relevance, null);
    assert.equal(describeTest('#164 SIGTERM: hs485d exits 0').relevance, null, 'no-sigterm is not classified');
    assert.equal(describeTest('pty hangup (the read-eof finding)').relevance, null);
});

test('relevanceOf: the most relevant class of the given findings, unknown and unclassified names ignored', () => {
    assert.equal(relevanceOf([]), null);
    assert.equal(relevanceOf(['no-such-finding', 'read-eof']), null);
    const r = relevanceOf(['double-join', 'exit-rpc', 'double-join']);
    assert.equal(r.relevance, 'edge');
    assert.deepEqual(r.findings, ['double-join', 'exit-rpc']);
    assert.equal(r.note, `${FINDINGS['double-join'].relevanceNote}; ${FINDINGS['exit-rpc'].relevanceNote}`);
    assert.equal(relevanceOf(['exit-rpc', 'ack-rssi-sign', 'json-substr']).relevance, 'field');
});
