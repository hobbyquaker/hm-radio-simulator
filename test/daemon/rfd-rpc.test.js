/**
 * rfd's RPC surface as a logic layer sees it: the method list over BIN-RPC and XML-RPC on one port, the device list,
 * the interface list, init and the receiver calls. rfd 3.89.11 does not start without a configured interface
 * (measured: "No BidCoS-Interface available", exit code 0), so these tests run with the simulated module attached;
 * the first test pins that behaviour down. Concept case 1.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {startRfd, spawnRfd, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {startReceiver} from '../helpers/rpc.js';
import {regression} from '../helpers/known.js';

test(
    'rfd without any [Interface] does not start: "No BidCoS-Interface available", exit 0',
    {...skipWithoutDaemons, timeout: 60000},
    async () => {
        const rfd = await spawnRfd({noInterface: true});
        const exit = await Promise.race([rfd.exited, new Promise((r) => setTimeout(() => r(null), 20000))]);
        try {
            assert.ok(exit, `rfd kept running without an interface:\n${rfd.tail()}`);
            assert.equal(exit.code, 0, 'rfd exits with code 0 on this error (measured on 3.89.11)');
            assert.ok(rfd.grep(/No BidCoS-Interface available/).length >= 1, rfd.tail());
        } finally {
            await rfd.stop();
        }
    },
);

test(
    'rfd serves its RPC methods over BIN-RPC and XML-RPC on the same port',
    {...skipWithoutDaemons, timeout: 120000},
    async () => {
        const rfd = await startRfd();
        await withDaemon(rfd, async () => {
            const methods = await rfd.call('system.listMethods');
            for (const name of [
                'init',
                'listDevices',
                'listBidcosInterfaces',
                'setValue',
                'getValue',
                'putParamset',
                'setInstallMode',
                'system.multicall',
            ]) {
                assert.ok(methods.includes(name), `method ${name}`);
            }
            const devices = await rfd.call('listDevices');
            assert.ok(Array.isArray(devices));
            for (const device of devices) {
                assert.equal(typeof device.ADDRESS, 'string');
            }
            assert.ok(
                devices.some((d) => d.ADDRESS === 'BidCoS-RF'),
                `the central BidCoS-RF is listed: ${devices.map((d) => d.ADDRESS).join(' ')}`,
            );
            const interfaces = await rfd.call('listBidcosInterfaces');
            assert.equal(interfaces.length, 1);
            assert.equal(interfaces[0].ADDRESS, rfd.module.serial);

            const viaXml = await rfd.xmlrpc.call('system.listMethods');
            assert.deepEqual([...viaXml].sort(), [...methods].sort(), 'the same method list over XML-RPC');
            const installMode = await rfd.xmlrpc.call('getInstallMode');
            assert.equal(installMode, 0);
        });
    },
);

test(
    'init registers a receiver: rfd asks it for its methods and calls listDevices/newDevices on it',
    {...skipWithoutDaemons, timeout: 120000},
    async () => {
        const rfd = await startRfd();
        const receiver = await startReceiver();
        await withDaemon(rfd, async () => {
            await rfd.call('init', [receiver.url, 'hmrs-test']);
            await receiver.waitFor('listDevices', 15000);
            assert.ok(receiver.calls('system.listMethods').length >= 1, 'rfd asks the receiver for its methods');
            await receiver.waitFor('newDevices', 15000);
            const newDevices = receiver.calls('newDevices')[0];
            assert.equal(newDevices.params[0], 'hmrs-test', 'the interface id rfd was given');
            assert.ok(Array.isArray(newDevices.params[1]));
            assert.ok(
                newDevices.params[1].some((d) => d.ADDRESS === 'BidCoS-RF'),
                'the central is announced as a new device',
            );
            assert.ok(rfd.alive);
        }).finally(() => receiver.stop());
    },
);

test(
    'init with an empty id deregisters the receiver and rfd stays up (the double-join finding under ASan)',
    {...skipWithoutDaemons, ...regression('double-join'), timeout: 120000},
    async () => {
        // Deregistering tears the receiver's event dispatcher down; under AddressSanitizer rfd 3.89.11 aborts there
        // with "pthread_join: thread not found" - the dispatcher's thread is joined a second time (Actor::Stop() from
        // the destructor after an explicit Stop()). The release build does not notice: the second join just fails.
        const rfd = await startRfd();
        const receiver = await startReceiver();
        await withDaemon(rfd, async () => {
            await rfd.call('init', [receiver.url, 'hmrs-test']);
            await receiver.waitFor('newDevices', 15000);
            await rfd.call('init', [receiver.url, '']);
            await new Promise((r) => setTimeout(r, 1000));
            assert.ok(rfd.alive, `rfd died on the deregistration: ${JSON.stringify(rfd.exit)}`);
            assert.ok(Array.isArray(await rfd.call('listDevices')));
            assert.equal(
                rfd.sanitizerReports().length,
                0,
                rfd
                    .sanitizerReports()
                    .map((r) => r.text)
                    .join('\n'),
            );
        }).finally(() => receiver.stop());
    },
);

test('a getValue on an unknown address faults, rfd stays up', {...skipWithoutDaemons, timeout: 120000}, async () => {
    const rfd = await startRfd();
    await withDaemon(rfd, async () => {
        // binrpc hands a fault back as an error or as the fault struct, depending on its version
        const outcome = await rfd.call('getValue', ['NOSUCH0001:1', 'STATE']).then(
            (result) => ({result}),
            (error) => ({error}),
        );
        if (outcome.result !== undefined) {
            assert.ok(
                outcome.result && typeof outcome.result === 'object' && 'faultCode' in outcome.result,
                `a fault, got ${JSON.stringify(outcome.result)}`,
            );
        }
        assert.ok(rfd.alive);
        assert.ok(Array.isArray(await rfd.call('system.listMethods')));
    });
});
