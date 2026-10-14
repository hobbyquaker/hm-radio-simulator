/**
 * hs485d without a wired gateway: its RPC surface against a silent TCP bus, and the same hostile-input classes as
 * for rfd (#138, #140, #189). hs485d's XML-RPC port is fixed at 2000, so this file runs its daemons one after another.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {startHs485d, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {sendRaw, sendRawXml, deeplyNestedXml, deeplyNestedBinRpc} from '../helpers/rpc.js';
import {regression} from '../helpers/known.js';
import {malformedRequests} from '../../lib/binrpc-raw.js';

/** A TCP endpoint that accepts hs485d's bus connection and says nothing: an RS485 line with nobody on it. */
async function silentBus() {
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        async close() {
            for (const s of sockets) {
                s.destroy();
            }
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}

test(
    'hs485d starts against a silent bus and serves listMethods and an empty listDevices',
    {...skipWithoutDaemons, timeout: 120000},
    async () => {
        const bus = await silentBus();
        const hs485d = await startHs485d({host: '127.0.0.1', port: bus.port});
        await withDaemon(hs485d, async () => {
            const methods = await hs485d.call('system.listMethods');
            for (const name of ['init', 'listDevices', 'getValue', 'setValue', 'system.multicall']) {
                assert.ok(methods.includes(name), `method ${name}`);
            }
            const devices = await hs485d.call('listDevices');
            assert.ok(Array.isArray(devices));
            const viaXml = await hs485d.xmlrpc.call('system.listMethods');
            assert.deepEqual([...viaXml].sort(), [...methods].sort());
        }).finally(() => bus.close());
    },
);

test(
    '#138 on hs485d: a nested system.multicall is refused, hs485d stays up',
    {...skipWithoutDaemons, ...regression(138), timeout: 180000},
    async () => {
        const bus = await silentBus();
        const hs485d = await startHs485d({host: '127.0.0.1', port: bus.port});
        await withDaemon(hs485d, async () => {
            const nested = [
                {methodName: 'system.multicall', params: [[{methodName: 'system.listMethods', params: []}]]},
            ];
            const outcome = await hs485d.call('system.multicall', [nested], {timeout: 30000}).then(
                (result) => ({result}),
                (error) => ({error}),
            );
            assert.ok(hs485d.alive, 'hs485d survives the nested multicall');
            if (outcome.result) {
                const entry = outcome.result[0];
                assert.ok(
                    entry && typeof entry === 'object' && 'faultCode' in entry,
                    `refused, got ${JSON.stringify(entry)}`,
                );
            }
            assert.ok(Array.isArray(await hs485d.call('system.listMethods')));
        }).finally(() => bus.close());
    },
);

test(
    '#140 on hs485d: malformed BIN-RPC requests never crash it',
    {...skipWithoutDaemons, ...regression(140), timeout: 180000},
    async () => {
        const bus = await silentBus();
        const hs485d = await startHs485d({host: '127.0.0.1', port: bus.port});
        await withDaemon(hs485d, async (daemon) => {
            for (const {name, bytes, mayWait} of malformedRequests()) {
                const outcome = await sendRaw(daemon.port, bytes);
                assert.ok(daemon.alive, `hs485d died on: ${name} (${JSON.stringify(daemon.exit)})`);
                assert.ok(
                    mayWait || outcome.response.length > 0 || outcome.closedByPeer || outcome.error,
                    `${name}: neither an answer nor a close`,
                );
            }
            assert.ok(Array.isArray(await daemon.call('system.listMethods')));
            assert.equal(daemon.sanitizerReports().length, 0);
        }).finally(() => bus.close());
    },
);

test(
    '#189 on hs485d: a deeply nested XML-RPC and BIN-RPC value is refused and hs485d stays up (no stack overflow)',
    {...skipWithoutDaemons, ...regression(189), timeout: 180000},
    async () => {
        // The recursive array/struct parser of 3.89.11 overflows the server thread's stack on a value nested this deep
        // (measured: SIGSEGV at depth 100000 for every shape on hs485d). #189 limits the nesting to 64 levels.
        const depth = 100000;
        const cases = [
            {label: 'BIN-RPC array', send: (port) => sendRaw(port, deeplyNestedBinRpc(depth, 'array'))},
            {label: 'BIN-RPC struct', send: (port) => sendRaw(port, deeplyNestedBinRpc(depth, 'struct'))},
            {label: 'XML-RPC array', send: (port) => sendRawXml(port, deeplyNestedXml(depth, 'array'), {maxMs: 30000})},
            {
                label: 'XML-RPC struct',
                send: (port) => sendRawXml(port, deeplyNestedXml(depth, 'struct'), {maxMs: 30000}),
            },
        ];
        const bus = await silentBus();
        const hs485d = await startHs485d({host: '127.0.0.1', port: bus.port});
        await withDaemon(hs485d, async (daemon) => {
            for (const {label, send} of cases) {
                const outcome = await send(daemon.port);
                assert.ok(daemon.alive, `hs485d died on a deeply nested ${label} (${JSON.stringify(daemon.exit)})`);
                assert.ok(
                    outcome.response.length > 0 || outcome.closedByPeer || outcome.error,
                    `${label}: neither an answer nor a close`,
                );
                assert.ok(
                    Array.isArray(await daemon.call('system.listMethods', [], {timeout: 60000})),
                    `hs485d stopped serving after a deeply nested ${label}`,
                );
            }
            assert.equal(daemon.sanitizerReports().length, 0, 'a sanitizer caught the deep nesting');
        }).finally(() => bus.close());
    },
);
