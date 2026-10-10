/**
 * hs485d without a wired gateway: its RPC surface against a silent TCP bus, and the same hostile-input classes as
 * for rfd (#138, #140). hs485d's XML-RPC port is fixed at 2000, so this file runs its daemons one after another.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {startHs485d, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {sendRaw} from '../helpers/rpc.js';
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
            for (const {name, bytes} of malformedRequests()) {
                const outcome = await sendRaw(daemon.port, bytes);
                assert.ok(daemon.alive, `hs485d died on: ${name} (${JSON.stringify(daemon.exit)})`);
                assert.ok(
                    outcome.response.length > 0 || outcome.closedByPeer || outcome.error,
                    `${name}: neither an answer nor a close`,
                );
            }
            assert.ok(Array.isArray(await daemon.call('system.listMethods')));
            assert.equal(daemon.sanitizerReports().length, 0);
        }).finally(() => bus.close());
    },
);
