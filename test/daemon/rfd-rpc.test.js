/**
 * rfd's RPC surface as a logic layer sees it: the method list over BIN-RPC and XML-RPC on one port, the device list,
 * the interface list, init and the receiver calls. rfd 3.89.11 does not start without a configured interface
 * (measured: "No BidCoS-Interface available", exit code 0), so these tests run with the simulated module attached;
 * the first test pins that behaviour down. Concept case 1.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {startRfd, spawnRfd, withDaemon, skipWithoutDaemons, RFTYPES} from '../helpers/daemon.js';
import {startReceiver} from '../helpers/rpc.js';
import {regression} from '../helpers/known.js';
import {announcement} from '../helpers/sweep.js';
import {loadDeviceDescription} from '../../lib/rftypes.js';

/** OpenCCU-Base's replace map (src/devicetypes/replaceMap), copied into the image next to the rftypes. */
const REPLACE_MAP = process.env.HMRS_REPLACEMAP || '/opt/openccu-base/replaceMap/rfReplaceMap.xml';

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
    '#269 (#161): init with an empty id deregisters the receiver and rfd stays up (under ASan)',
    {...skipWithoutDaemons, ...regression(269), timeout: 120000},
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

test(
    '#269 (#161): a receiver deregistered right after its registration, twenty times: rfd keeps answering',
    {...skipWithoutDaemons, ...regression(269), timeout: 180000},
    async () => {
        // Before #269 the actor marked itself running only in its new thread: a Stop() that came first skipped the
        // signal, and the join then blocked rfd's main loop for good. That window is a race, so this repeats it; the
        // calls have no timing assumption of their own beyond the RPC client's timeout (a hang fails on it).
        const rfd = await startRfd();
        const receiver = await startReceiver();
        await withDaemon(rfd, async () => {
            for (let i = 0; i < 20; i++) {
                await Promise.all([
                    rfd.call('init', [receiver.url, `hmrs-${i}`]),
                    rfd.call('init', [receiver.url, '']),
                ]);
            }
            await rfd.call('init', [receiver.url, '']);
            assert.ok(Array.isArray(await rfd.call('listDevices')));
            assert.ok(rfd.alive);
            assert.deepEqual(rfd.sanitizerReports(), []);
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

test(
    "the central's maintenance channel BidCoS-RF:0: INSTALL_MODE through getValue and setValue, AES_KEY from its MASTER paramset",
    {...skipWithoutDaemons, timeout: 120000},
    async (t) => {
        // timing: setValue INSTALL_MODE = true opens the install mode for 60 s (RFCentral::SetInternalValue); the test
        // reads it back within a few hundred ms, well inside that
        const rfd = await startRfd();
        await withDaemon(rfd, async () => {
            const channel = 'BidCoS-RF:0';
            assert.equal(await rfd.call('getValue', [channel, 'INSTALL_MODE']), false, 'off after the start');
            await rfd.call('setValue', [channel, 'INSTALL_MODE', true]);
            const left = await rfd.call('getInstallMode');
            assert.ok(left > 50 && left <= 60, `getInstallMode: ${left} s left of the central's 60`);
            assert.equal(await rfd.call('getValue', [channel, 'INSTALL_MODE']), true);
            await rfd.call('setValue', [channel, 'INSTALL_MODE', false]);
            assert.equal(await rfd.call('getInstallMode'), 0, 'off again');
            assert.equal(await rfd.call('getValue', [channel, 'INSTALL_MODE']), false);
            const values = await rfd.call('getParamset', [channel, 'VALUES']);
            const master = await rfd.call('getParamset', [channel, 'MASTER']);
            t.diagnostic(`VALUES ${JSON.stringify(values)}, MASTER ${JSON.stringify(master)}`);
            assert.deepEqual(Object.keys(values), ['INSTALL_MODE']);
            assert.equal(typeof master.AES_KEY, 'number', 'the current key index');
            assert.deepEqual(rfd.sanitizerReports(), []);
        });
    },
);

test(
    "listReplaceableDevices with OpenCCU-Base's replace map: a different type the map allows is offered, the same type always, an unrelated one never",
    {...skipWithoutDaemons, timeout: 120000},
    async (t) => {
        if (!fs.existsSync(REPLACE_MAP)) {
            t.skip(`no replace map in the image (${REPLACE_MAP})`);
            return;
        }
        // timing: none beyond the RPC answers; rfd reads the map on the first listReplaceableDevices that needs it
        const rfd = await startRfd({extra: `Replacemap File = ${REPLACE_MAP}`});
        await withDaemon(rfd, async () => {
            const switches = loadDeviceDescription(path.join(RFTYPES, 'rf_s.xml'));
            const blinds = loadDeviceDescription(path.join(RFTYPES, 'rf_bl.xml'));
            const add = async (description, type, address, serial) => {
                const added = await rfd.call('addVirtualDeviceInstance', [
                    [...announcement(description, type, address, serial)],
                ]);
                assert.equal(added, true, `${serial} (${type})`);
            };
            // the map's first entry: ZEL STG RM FZS-2 may replace HM-LC-Sw1-PB-FM and HM-LC-Sw1-Pl-2 (firmware >= 2.4)
            await add(switches, 'ZEL STG RM FZS-2', 0x4f5001, 'RPLNEW0001');
            await add(switches, 'HM-LC-Sw1-PB-FM', 0x4f5002, 'RPLOLD0001');
            await add(switches, 'HM-LC-Sw1-Pl-2', 0x4f5003, 'RPLOLD0002');
            await add(switches, 'ZEL STG RM FZS-2', 0x4f5004, 'RPLSAME001');
            await add(blinds, 'HM-LC-Bl1-FM', 0x4f5005, 'RPLBLIND01');
            const offered = (await rfd.call('listReplaceableDevices', ['RPLNEW0001']))
                .map((d) => d.ADDRESS)
                .filter((a) => !a.includes(':'))
                .sort();
            t.diagnostic(`replaceable by RPLNEW0001: ${offered.join(' ') || 'none'}`);
            assert.deepEqual(offered, ['RPLOLD0001', 'RPLOLD0002', 'RPLSAME001']);
            assert.ok(rfd.grep(/unable to load replace map/).length === 0, 'the map was read');
            // the other way round the map has no entry: HM-LC-Sw1-PB-FM is not a new type of it
            const back = (await rfd.call('listReplaceableDevices', ['RPLOLD0001'])).map((d) => d.ADDRESS);
            t.diagnostic(`replaceable by RPLOLD0001: ${back.filter((a) => !a.includes(':')).join(' ') || 'none'}`);
            assert.ok(!back.includes('RPLBLIND01'), 'never the blind actuator');
            assert.deepEqual(rfd.sanitizerReports(), []);
        });
    },
);
