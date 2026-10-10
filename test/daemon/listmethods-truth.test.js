/**
 * listMethods tells the truth, at runtime and in both directions, for rfd and hs485d over BIN-RPC and XML-RPC:
 * every name `system.listMethods` returns can be called, and no name it leaves out can.
 *
 * The oracle is libXmlRpc's own dispatch (XmlRpcServerConnection::executeRequest): a name `findMethod` does not know
 * gets the fault "<name>: unknown method name" before anything runs; `system.methodHelp(name)` asks the same
 * `findMethod` and answers "Unknown method name" for those, without running the method. So:
 *
 * - listed names: `system.methodHelp` must know each; the harmless ones (getters, lists) are also called with no
 *   arguments and must not answer "unknown method name". The destructive ones (exit, deleteDevice, updateFirmware,
 *   restoreConfigToDevice, clearConfigCache, changeKey, ...) are never called: most of them index their arguments
 *   without checking the count (XmlRpcMethods.cpp), so even an empty call could reach the body, and `exit` takes none.
 * - unlisted candidates - every name the daemons' sources define (registered or not, scripts/method-table.mjs
 *   --all), the other daemon's methods, names from other Homematic interfaces, introspection names other servers
 *   have, case and whitespace variants: `system.methodHelp` must not know them, and a direct call with probe
 *   arguments must answer "unknown method name". The direct call is made only after methodHelp said unknown, so no
 *   registered method is ever run by it.
 *
 * Every answer is recorded (results/<variant>/sweep/<daemon>-listmethods-<protocol>.json), so the differential shows a
 * method added or removed upstream; the summary (listed / callable / unlisted but callable) goes into the report.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {startRfd, startHs485d, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {readMethodTable, writeRecord, summarize} from '../helpers/sweep.js';

/** Listed names that are called with no arguments: they only read. */
const HARMLESS = new Set([
    'system.listMethods',
    'system.methodHelp',
    'listDevices',
    'listTeams',
    'listBidcosInterfaces',
    'getVersion',
    'getInstallMode',
    'getServiceMessages',
    'rssiInfo',
    'getLGWStatus',
    'getDeviceDescription',
    'getParamsetDescription',
    'getParamset',
    'getParamsetId',
    'getValue',
    'getLinkPeers',
    'getLinks',
    'getLinkInfo',
    'getMetadata',
    'getAllMetadata',
    'getVolatileMetadata',
    'hasVolatileMetadata',
    'listReplaceableDevices',
    'getKeyMismatchDevice',
]);

/** Method names other Homematic interface processes and logic layers use (public API documentation). */
const OTHER_NAMES = [
    'installFirmware',
    'setInstallModeWithWhitelist',
    'getInstallModeWithWhitelist',
    'listInterfaces',
    'getDeviceDescriptions',
    'getFirmwareUpdateState',
    'setPresent',
    'getParameterDescription',
    'putParamsetDescription',
    'deleteDevices',
    'newDevices',
    'event',
    'updateDevice',
    'getAllSystemVariables',
    'getSystemVariable',
    'setSystemVariable',
    'rssiInfoReset',
    'reset',
    'shutdown',
    'restart',
    'quit',
    'debug',
    'dump',
];

/** Introspection names other XML-RPC servers implement. */
const INTROSPECTION = ['system.methodSignature', 'system.getCapabilities', 'system.describeMethods', 'system.shutdown'];

const UNKNOWN = /unknown method name/i;

/** Answer summary over the given client: the result, or the fault text. */
async function ask(client, method, params) {
    try {
        const r = await client.call(method, params, {timeout: 10000});
        return summarize(r);
    } catch (error) {
        if (error && (error.faultString || error.faultCode !== undefined)) {
            return `fault ${error.faultCode} ${error.faultString}`;
        }
        return `error ${error.message}`.slice(0, 160);
    }
}

function variants(names) {
    const out = new Set();
    for (const n of names.slice(0, 6)) {
        out.add(n.toUpperCase());
        out.add(n[0].toUpperCase() + n.slice(1));
        out.add(` ${n}`);
        out.add(`${n} `);
    }
    out.add('system.');
    out.add('system.listmethods');
    out.add('*');
    return [...out];
}

const FLAVOURS = [
    {name: 'rfd', other: 'hs485d', start: () => startRfd()},
    {name: 'hs485d', other: 'rfd', start: () => startHs485d({lgwFront: {serial: 'SIMWLGW001'}})},
];

for (const flavour of FLAVOURS) {
    for (const proto of ['binrpc', 'xmlrpc']) {
        test(
            `${flavour.name} over ${proto}: every listed method is callable, no unlisted name is (system.methodHelp and direct calls)`,
            {...skipWithoutDaemons, timeout: 300000},
            async (t) => {
                const daemon = await flavour.start();
                await withDaemon(daemon, async () => {
                    const client = proto === 'xmlrpc' ? daemon.xmlrpc : daemon.rpc;
                    const listed = (await client.call('system.listMethods')).slice().sort();
                    const record = {listed: {}, unlisted: {}, introspection: {}};

                    // 1. listed names: known to findMethod; the harmless ones answer something other than unknown
                    const notCallable = [];
                    const helpGaps = [];
                    let helpTexts = 0;
                    for (const name of listed) {
                        const help = await ask(client, 'system.methodHelp', [name]);
                        let call = 'not called (may change state)';
                        if (HARMLESS.has(name)) {
                            call = await ask(client, name, []);
                        } else if (name === 'system.multicall') {
                            // built into XmlRpcServerConnection, not a registered method: methodHelp cannot know it
                            call = await ask(client, name, [[]]);
                        }
                        record.listed[name] = {help, call};
                        const helpKnows = !/Unknown method name/i.test(help);
                        if (!helpKnows) {
                            helpGaps.push(name);
                        }
                        if (UNKNOWN.test(call) || (!helpKnows && !call.startsWith('array'))) {
                            notCallable.push(name);
                        }
                        if (/^string "./.test(help) || /^string\(/.test(help)) {
                            helpTexts++;
                        }
                    }

                    // 2. unlisted candidates: methodHelp must not know them, a direct probe call must be refused
                    const candidates = new Set([
                        ...(readMethodTable(`${flavour.name}-all`) || []),
                        ...(readMethodTable(flavour.other) || []),
                        ...(readMethodTable(`${flavour.other}-all`) || []),
                        ...OTHER_NAMES,
                        ...INTROSPECTION,
                        ...variants(listed.filter((n) => !n.startsWith('system.'))),
                    ]);
                    const unlistedCallable = [];
                    const anomalies = [];
                    for (const name of [...candidates].filter((n) => !listed.includes(n)).sort()) {
                        const help = await ask(client, 'system.methodHelp', [name]);
                        let call = 'not called (methodHelp knows it)';
                        if (/Unknown method name/i.test(help)) {
                            call = await ask(client, name, ['__probe__', {}, []]);
                        }
                        record.unlisted[JSON.stringify(name)] = {help, call};
                        // methodHelp asks the dispatcher's own findMethod: it decides; the direct call cross-checks
                        if (!/Unknown method name/i.test(help)) {
                            unlistedCallable.push(name);
                        } else if (!UNKNOWN.test(call)) {
                            anomalies.push(`${JSON.stringify(name)}: ${call}`);
                        }
                    }

                    // 3. introspection beyond listMethods/methodHelp
                    for (const name of INTROSPECTION) {
                        record.introspection[name] = await ask(client, name, ['listDevices']);
                    }

                    record.summary = {
                        listed: listed.length,
                        callable: listed.length - notCallable.length,
                        probed: candidates.size,
                        unlistedCallable,
                        anomalies,
                        helpGaps,
                        helpTexts,
                    };
                    writeRecord(`${flavour.name}-listmethods-${proto}`, record);
                    t.diagnostic(
                        `${listed.length} listed, ${listed.length - notCallable.length} callable, ${helpTexts} with a help text, methodHelp does not know ${helpGaps.join(' ') || 'none'}; ${[...candidates].filter((n) => !listed.includes(n)).length} unlisted names probed, callable: ${unlistedCallable.join(' ') || 'none'}; methodSignature: ${record.introspection['system.methodSignature']}; direct calls not refused as unknown: ${anomalies.join('; ') || 'none'}`,
                    );
                    assert.deepEqual(notCallable, [], 'listed but unknown to the dispatcher');
                    assert.deepEqual(unlistedCallable, [], 'callable but not listed');
                    assert.ok(daemon.alive);
                    assert.deepEqual(daemon.sanitizerReports(), []);
                });
            },
        );
    }
}
