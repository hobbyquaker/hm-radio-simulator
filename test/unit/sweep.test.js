import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {methodTable, stripComments} from '../../scripts/method-table.mjs';
import {flatten, diffSweeps, buildDifferential} from '../../scripts/differential.mjs';
import {collectResults, buildReport, renderSummaryMarkdown, renderHtml, writeSite} from '../../scripts/report.mjs';
import {summarize, argsLabel} from '../helpers/sweep.js';
import {loadDeviceDescription, sysinfoSatisfying, readField} from '../../lib/rftypes.js';

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;

const SOURCE = `
//! a method
class XmlRpcMethodListDevices : public XmlRpcServerMethod
{
public:
	XmlRpcMethodListDevices(XmlRpcServer* s):XmlRpcServerMethod("listDevices", s){};
};
class XmlRpcMethodGone : public XmlRpcServerMethod
{
	XmlRpcMethodGone(XmlRpcServer* s):XmlRpcServerMethod("gone", s){};
};
/* class XmlRpcMethodOld : public XmlRpcServerMethod { XmlRpcMethodOld(XmlRpcServer* s):XmlRpcServerMethod("old", s){}; }; */
class XmlRpcMethodInit : public XmlRpcServerMethod
{
	XmlRpcMethodInit(XmlRpcServer* s):XmlRpcServerMethod("init", s){};
};
void InitXmlRpcMethods(XmlRpcServer& s)
{
	static XmlRpcMethodListDevices xmlRpcMethodListDevices(&s);
//	static XmlRpcMethodGone xmlRpcMethodGone(&s);
	static XmlRpcMethodInit xmlRpcMethodInit(&s);
}
`;
const MAIN = `
class XmlRpcMethodExit : public XmlRpcServerMethod
{
	XmlRpcMethodExit(XmlRpcServer* s):XmlRpcServerMethod("exit", s){};
	void execute(XmlRpc::XmlRpcValue& params, XmlRpc::XmlRpcValue& result) { run=false; }
}xmlRpcMethodExit(&s);
`;

test('method-table: the instantiated methods of InitXmlRpcMethods and the global instances, nothing commented out', () => {
    assert.deepEqual(methodTable([SOURCE, MAIN]), ['exit', 'init', 'listDevices']);
    assert.equal(stripComments('a // b\nc /* d */ e'), 'a \nc  e');
    assert.equal(stripComments('"xmlrpc_bin://host"'), '"xmlrpc_bin://host"');
});

test('sysinfoSatisfying: every condition of the type holds in the announcement (rfd and wired shapes)', () => {
    const rf = loadDeviceDescription(path.join(FIXTURES, 'rftypes/sim_switch.xml'));
    const bytes = sysinfoSatisfying(rf, 'SIM-Sw1', Buffer.alloc(26));
    assert.equal(bytes.length, 26);
    assert.equal(bytes[9], 0x24, 'the lowest firmware GE allows');
    assert.equal(readField(bytes, 10, 0, 16), 0x0011);
    const wired = loadDeviceDescription(path.join(FIXTURES, 'hs485types/sim_wired_switch.xml'));
    assert.deepEqual([...sysinfoSatisfying(wired, 'SIM-HMW-Sw2', Buffer.alloc(4))], [17, 0, 0x03, 0x03]);
    assert.throws(() => sysinfoSatisfying(rf, 'NOPE', Buffer.alloc(26)), /not in/);
    const contradictory = {
        file: 'x.xml',
        types: [
            {
                id: 'X',
                conditions: [
                    {index: {byte: 9, bit: 0}, sizeBits: 8, condOp: 'GE', constValue: 0x30},
                    {index: {byte: 9, bit: 0}, sizeBits: 8, condOp: 'LE', constValue: 0x20},
                ],
            },
        ],
    };
    assert.throws(() => sysinfoSatisfying(contradictory, 'X', Buffer.alloc(26)), /no value satisfies/);
});

test('summarize and argsLabel: short, deterministic texts', () => {
    assert.equal(summarize(null), 'nil');
    assert.equal(summarize([]), 'array[0]');
    assert.equal(summarize([{A: 1, B: 2}, {}]), 'array[2] of struct{2}');
    assert.equal(summarize({b: 1, a: 2}), 'struct{a,b}');
    assert.equal(summarize({faultCode: -2, faultString: 'Unknown instance'}), 'fault -2 Unknown instance');
    assert.equal(summarize('x'.repeat(61)), 'string(61)');
    assert.equal(summarize('ok'), 'string "ok"');
    assert.equal(summarize(true), 'boolean true');
    assert.equal(summarize(Buffer.alloc(3)), 'binary(3)');
    assert.equal(
        argsLabel(['a', 1, [], {X: 1}, {explicitDouble: 1.5}, 'B'.repeat(30)]),
        '"a", 1, [0], {X}, 1.5, "BBBBBBBB…"(30)',
    );
});

test('the differential: flattened records compared key by key, the version ignored by design', () => {
    assert.deepEqual(
        [...flatten({a: {b: 'x', c: ['1', '2']}, d: 'y'})],
        [
            ['a / b', 'x'],
            ['a / c', '1, 2'],
            ['d', 'y'],
        ],
    );
    const d = diffSweeps(
        {m: {'getVersion()': '1', 'a()': 'x', 'b()': 'y'}},
        {m: {'getVersion()': '2', 'a()': 'x', 'b()': 'z', 'c()': 'n'}},
    );
    assert.deepEqual(
        {added: d.added, removed: d.removed, changed: d.changed, equal: d.equal, ignored: d.ignored},
        {added: 1, removed: 0, changed: 1, equal: 1, ignored: 1},
    );
    assert.deepEqual(
        buildDifferential([{ref: 'main', variant: 'release', baseCommit: 'b', sweep: {m: {}}}], {
            ref: 'main',
            baseCommit: 'b',
            records: {},
        }),
        [],
        'the same main commit as last time: nothing to compare',
    );
});

test('the report carries the differential of the fixture refs and the previous main; the site keeps the records', () => {
    const results = collectResults([path.join(FIXTURES, 'report')]);
    const report = buildReport(results, {
        generatedAt: '2026-10-10T18:05:00.000Z',
        previousMain: {
            ref: 'main',
            baseCommit: '0000000000',
            records: {'rfd-methods': {'listDevices()': 'array[4] of struct{10}'}},
        },
    });
    assert.equal(report.differential.length, 2);
    const [refs, previous] = report.differential;
    assert.equal(refs.title, '3.89.11 → main');
    assert.deepEqual(
        {changed: refs.diff.changed, added: refs.diff.added, removed: refs.diff.removed, ignored: refs.diff.ignored},
        {changed: 1, added: 1, removed: 1, ignored: 1},
    );
    assert.ok(previous.title.startsWith('main: the previously tested commit'));
    assert.ok(
        report.jobs.every((j) => !('sweep' in JSON.parse(JSON.stringify(j)))),
        'the records stay out of report.json',
    );
    assert.deepEqual(
        report.listMethods.map((r) => [r.daemon, r.protocol, r.ref, r.listed, r.callable]),
        [
            ['rfd', 'binrpc', '3.89.11', 55, 55],
            ['rfd', 'binrpc', 'main', 55, 55],
        ],
    );
    const md = renderSummaryMarkdown(report);
    assert.match(md, /### listMethods tells the truth/);
    assert.match(md, /\| rfd \| binrpc \| main \| 55 \| 55 \| none \| system\.multicall \|/);
    assert.match(md, /### Differential: 3\.89\.11 → main/);
    assert.match(md, /fault -2 Unknown instance → fault -5 Unknown parameter/);
    const html = renderHtml(report);
    assert.match(html, /<h2>Differential<\/h2>/);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hmrs-site-'));
    try {
        writeSite(report, {out});
        const main = JSON.parse(fs.readFileSync(path.join(out, 'sweep', 'main.json'), 'utf8'));
        assert.equal(main.ref, 'main');
        assert.ok(main.records['rfd-methods']);
        assert.ok(fs.existsSync(path.join(out, 'sweep', '3.89.11.json')));
    } finally {
        fs.rmSync(out, {recursive: true, force: true});
    }
});
