/**
 * The RPC surface under hostile input: the classes OpenCCU-Base fixed in #138 (nested system.multicall recursion),
 * #140 (BIN-RPC deserializer bounds) and #27 (a receiver that goes away). Concept cases 9, 10, 11.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {startRfd, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {startReceiver, sendRaw, sendRawXml} from '../helpers/rpc.js';
import {regression} from '../helpers/known.js';
import {malformedRequests, encodeRequest} from '../../lib/binrpc-raw.js';

const options = (issue) => ({...skipWithoutDaemons, ...regression(issue), timeout: 180000});

test(
    '#138: a nested system.multicall is refused with a fault and rfd stays up; a flat 1000-entry multicall works',
    options(138),
    async () => {
        const rfd = await startRfd();
        await withDaemon(rfd, async () => {
            const flat = Array.from({length: 1000}, () => ({methodName: 'getInstallMode', params: []}));
            const results = await rfd.call('system.multicall', [flat], {timeout: 30000});
            assert.equal(results.length, 1000);

            const nested = [{methodName: 'system.multicall', params: [[{methodName: 'getInstallMode', params: []}]]}];
            let outcome;
            try {
                outcome = {result: await rfd.call('system.multicall', [nested], {timeout: 30000})};
            } catch (error) {
                outcome = {error};
            }
            assert.ok(rfd.alive, 'rfd survives the nested multicall');
            // either a fault for the whole call or a fault entry for the nested call; never a successful recursion
            if (outcome.result) {
                assert.equal(outcome.result.length, 1);
                const entry = outcome.result[0];
                const isFault = entry && typeof entry === 'object' && !Array.isArray(entry) && 'faultCode' in entry;
                assert.ok(isFault, `the nested call must be refused, got ${JSON.stringify(entry)}`);
            }
            // deeper nesting: 50 levels
            let deep = [{methodName: 'getInstallMode', params: []}];
            for (let i = 0; i < 50; i++) {
                deep = [{methodName: 'system.multicall', params: [deep]}];
            }
            await rfd.call('system.multicall', [deep], {timeout: 30000}).catch(() => {});
            assert.ok(rfd.alive, 'rfd survives 50 nested levels');
            assert.ok(Array.isArray(await rfd.call('system.listMethods')));
        });
    },
);

test('#140: malformed BIN-RPC requests get a fault or a closed connection, never a crash', options(140), async () => {
    const rfd = await startRfd();
    await withDaemon(rfd, async (daemon) => {
        for (const {name, bytes} of malformedRequests()) {
            const outcome = await sendRaw(daemon.port, bytes);
            assert.ok(daemon.alive, `rfd died on: ${name} (${JSON.stringify(daemon.exit)})`);
            assert.ok(
                outcome.response.length > 0 || outcome.closedByPeer || outcome.error,
                `${name}: neither an answer nor a close`,
            );
        }
        assert.ok(Array.isArray(await daemon.call('system.listMethods')), 'rfd still answers');
        const reports = daemon.sanitizerReports();
        assert.equal(reports.length, 0, `sanitizer reports:\n${reports.map((r) => r.text).join('\n')}`);
    });
});

test(
    'a well-formed raw BIN-RPC request gets a BIN-RPC response',
    {...skipWithoutDaemons, timeout: 120000},
    async () => {
        const rfd = await startRfd();
        await withDaemon(rfd, async (daemon) => {
            const outcome = await sendRaw(daemon.port, encodeRequest('getInstallMode', []));
            assert.equal(outcome.response.subarray(0, 3).toString('ascii'), 'Bin');
            assert.equal(outcome.response[3], 0x01, 'a response message');
        });
    },
);

test(
    'hostile XML-RPC: a deeply nested value tree and a truncated body do not crash or wedge rfd',
    {...skipWithoutDaemons, timeout: 240000},
    async (t) => {
        const rfd = await startRfd();
        await withDaemon(rfd, async (daemon) => {
            const depth = 3000;
            const deep =
                '<?xml version="1.0"?><methodCall><methodName>getInstallMode</methodName><params><param>' +
                '<value><array><data>'.repeat(depth) +
                '<value><int>1</int></value>' +
                '</data></array></value>'.repeat(depth) +
                '</param></params></methodCall>';
            const outcome = await sendRawXml(daemon.port, deep, {idleMs: 3000, maxMs: 30000});
            t.diagnostic(
                `deep tree: ${outcome.response.length} bytes back, closed ${outcome.closedByPeer}, error ${outcome.error}`,
            );
            assert.ok(daemon.alive, `rfd died on the deep value tree (${JSON.stringify(daemon.exit)})`);
            // whether rfd answered, closed or is still chewing: it must keep serving other clients
            assert.ok(Array.isArray(await daemon.call('system.listMethods', [], {timeout: 60000})), 'rfd still serves');

            const truncated =
                '<?xml version="1.0"?><methodCall><methodName>setValue</methodName><params><param><value><struct><member><name>';
            await sendRawXml(daemon.port, truncated);
            assert.ok(daemon.alive, 'rfd died on the truncated XML');
            assert.ok(Array.isArray(await daemon.call('system.listMethods')));
            assert.equal(daemon.sanitizerReports().length, 0);
        });
    },
);

test(
    '#27: a receiver that disappears does not take rfd down; another receiver keeps being served',
    {...skipWithoutDaemons, ...regression(27), timeout: 180000},
    async () => {
        const rfd = await startRfd();
        const good = await startReceiver();
        const bad = await startReceiver();
        await withDaemon(rfd, async () => {
            await rfd.call('init', [good.url, 'good']);
            await good.waitFor('newDevices', 15000);
            await rfd.call('init', [bad.url, 'bad']);
            await bad.waitFor('system.listMethods', 15000);
            // the receiver vanishes while rfd may still be talking to it
            await bad.stop();
            // make rfd talk to its receivers again
            for (let i = 0; i < 3; i++) {
                await rfd.call('init', [good.url, 'good']).catch(() => {});
                await rfd.call('setValue', ['BidCoS-RF:1', 'PRESS_SHORT', true]).catch(() => {});
            }
            await new Promise((r) => setTimeout(r, 3000));
            assert.ok(rfd.alive, `rfd died after its receiver went away (${JSON.stringify(rfd.exit)})`);
            const before = good.calls('listDevices').length;
            await rfd.call('init', [good.url, 'good']);
            await new Promise((r) => setTimeout(r, 2000));
            assert.ok(good.calls('listDevices').length > before, 'the remaining receiver is still served');
            assert.equal(rfd.sanitizerReports().length, 0);
        }).finally(() => good.stop());
    },
);
