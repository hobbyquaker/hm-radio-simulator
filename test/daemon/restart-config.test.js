/**
 * Restart, device files and configuration: what survives a restart (every device type from its file, the address,
 * the registered receivers), what rfd makes of broken or odd device files, the address donation of a fresh system,
 * and the start-up matrix - config file missing, an unknown interface type, the log destinations, the unix-domain
 * socket, a taken port, two interfaces, the legacy coprocessor initialisation, sniffing mode; for hs485d the restart
 * of every wired type and the extra description directory /etc/config/hs485types.
 *
 * rfd is stopped through its `exit` RPC method (always compiled in, rfd.cpp): the main loop ends and exit(0) runs, the
 * clean shutdown a coverage build needs. hs485d has neither `exit` nor a SIGTERM handler; it writes a device's file
 * when the device changes, so a SIGTERM loses nothing here.
 *
 * Timing assumptions: rfd ends within 15 s of `exit` (its main loop returns after the current dispatch, the
 * interface threads are joined); a daemon that refuses to start does so within 20 s.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import {
    startRfd,
    spawnRfd,
    startHs485d,
    withDaemon,
    skipWithoutDaemons,
    tmpdir,
    RFTYPES,
    HS485TYPES,
} from '../helpers/daemon.js';
import {startReceiver, freePort} from '../helpers/rpc.js';
import {announcement, allTypes, usesStringUint} from '../helpers/sweep.js';
import {isKnownBroken} from '../helpers/known.js';
import {RadioModule} from '../../lib/module.js';
import {createPtyModule} from '../../lib/pty.js';
import {loadDeviceDescription, sysinfoSatisfying} from '../../lib/rftypes.js';
import {WiredBus, WiredDevice} from '../../lib/wired.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 300000, ...extra});

/** rfd with the fast-failing empty air of the sweeps (the virtual devices ask for their config; nobody answers). */
async function startQuietRfd(extra = {}) {
    // 5 ms: on a restart rfd tries to give every device the current AES key before it serves RPC (two tries per key
    // index, devices made with index 0), several hundred devices times the module's 3 s would be half an hour
    return startRfd({module: {failDelayMs: 5}, quietAir: true, ...extra});
}

/** The device list as a comparable set: address, type, version, parent, firmware. */
async function snapshot(daemon) {
    const devices = await daemon.call('listDevices', [], {timeout: 60000});
    return devices.map((d) => `${d.ADDRESS}|${d.TYPE}|${d.VERSION}|${d.PARENT}|${d.FIRMWARE ?? ''}`).sort();
}

/** Waits for a spawned daemon to end, or null after `ms`. */
function exitWithin(daemon, ms) {
    return Promise.race([daemon.exited, sleep(ms).then(() => null)]);
}

async function addSwitch(rfd, serial, address) {
    const description = loadDeviceDescription(path.join(RFTYPES, 'rf_s.xml'));
    const added = await rfd.call('addVirtualDeviceInstance', [
        [...announcement(description, 'HM-LC-Sw1-Pl', address, serial)],
    ]);
    assert.equal(added, true, `virtual ${serial}`);
}

test(
    'rfd restart: one device of every rftypes type, stopped through exit, comes back from its file with the same address, type, version and channels',
    options({timeout: 900000}),
    async (t) => {
        const first = await startQuietRfd();
        const dir = first.workdir;
        let before;
        let added = 0;
        await withDaemon(first, async () => {
            let i = 0;
            for (const {file, description, typeId} of allTypes()) {
                i++;
                if (isKnownBroken('string-uint-conversion') && usesStringUint(file)) {
                    continue;
                }
                const result = await first.call('addVirtualDeviceInstance', [
                    [...announcement(description, typeId, 0x500000 + i, `SWR${String(i).padStart(7, '0')}`)],
                ]);
                if (result === true) {
                    added++;
                }
            }
            before = await snapshot(first);
            const at = Date.now();
            const exit = await first.exitViaRpc();
            t.diagnostic(`exit after ${added} devices: ${JSON.stringify(exit)} in ${Date.now() - at} ms`);
            assert.ok(exit, `rfd did not end within 15 s of exit\n${first.tail(20)}`);
            assert.equal(exit.code, 0, 'exit(0)');
            assert.deepEqual(first.sanitizerReports(), []);
        });
        const files = fs.readdirSync(path.join(dir, 'devices')).filter((f) => f.endsWith('.dev'));
        assert.equal(files.length, added, 'one file per device');

        const second = await startQuietRfd({dir});
        await withDaemon(second, async () => {
            const after = await snapshot(second);
            const missing = before.filter((x) => !after.includes(x));
            const extra = after.filter((x) => !before.includes(x));
            // the smoke detectors' team devices (*<serial>) are created when a device is loaded from its file, not by
            // addVirtualDeviceInstance - they are the only addresses a restart may add
            const teams = extra.filter((x) => x.startsWith('*'));
            t.diagnostic(
                `${after.length} addresses after the restart; missing ${missing.length}, new ${extra.length} (${teams.length} of them team addresses: ${[...new Set(teams.map((x) => x.split('|')[0].split(':')[0]))].join(' ')})`,
            );
            assert.deepEqual({missing, extra: extra.filter((x) => !x.startsWith('*'))}, {missing: [], extra: []});
            assert.deepEqual(second.sanitizerReports(), []);
        });
    },
);

test(
    'rfd restart: a truncated file, a garbage file, an empty file, a directory named X.dev, leftover .bak/.new copies and a file missing a channel - rfd starts and keeps the good devices',
    options(),
    async (t) => {
        const first = await startQuietRfd();
        const dir = first.workdir;
        const devices = path.join(dir, 'devices');
        await withDaemon(first, async () => {
            await addSwitch(first, 'SWPBAD0001', 0x4f2001);
            await addSwitch(first, 'SWPBAK0001', 0x4f2002);
            await addSwitch(first, 'SWPCHN0001', 0x4f2003);
            await addSwitch(first, 'SWPGOOD001', 0x4f2004);
            assert.ok(await first.exitViaRpc(), 'rfd ended');
        });
        const read = (name) => fs.readFileSync(path.join(devices, `${name}.dev`), 'latin1');
        const truncated = read('SWPBAD0001');
        fs.writeFileSync(path.join(devices, 'SWPBAD0001.dev'), truncated.slice(0, Math.floor(truncated.length / 2)));
        fs.writeFileSync(path.join(devices, 'JUNK000001.dev'), Buffer.from([0x00, 0xff, 0x3c, 0x3f, 0x13, 0x37, 0x0a]));
        fs.writeFileSync(path.join(devices, 'EMPTY00001.dev'), '');
        // a directory named like a device file (OpenCCU-Base #29: parseFile() did not check seek, size and read; on a
        // directory ftell can report a huge size)
        fs.mkdirSync(path.join(devices, 'DIRDEV0001.dev'));
        for (const suffix of ['.bak', '.new', '~']) {
            fs.copyFileSync(path.join(devices, 'SWPBAK0001.dev'), path.join(devices, `SWPBAK0001.dev${suffix}`));
        }
        const withoutChannel2 = read('SWPCHN0001').replace(/\t<channel index="2"[\s\S]*?\n\t<\/channel>\n/, '');
        assert.notEqual(withoutChannel2, read('SWPCHN0001'), 'channel 2 cut out of the file');
        fs.writeFileSync(path.join(devices, 'SWPCHN0001.dev'), withoutChannel2);

        const second = await startQuietRfd({dir});
        await withDaemon(second, async () => {
            const list = (await second.call('listDevices')).map((d) => d.ADDRESS);
            t.diagnostic(
                `after the restart: ${list.filter((a) => a.startsWith('SWP') || a.startsWith('JUNK')).join(' ')}`,
            );
            for (const good of ['SWPGOOD001', 'SWPBAK0001', 'SWPCHN0001']) {
                assert.ok(list.includes(good), `${good} is back`);
            }
            assert.equal(list.filter((a) => a === 'SWPBAK0001').length, 1, 'the leftover copies add nothing');
            assert.ok(!list.includes('JUNK000001') && !list.includes('EMPTY00001') && !list.includes('DIRDEV0001'));
            const channels = (await second.call('getDeviceDescription', ['SWPCHN0001'])).CHILDREN;
            t.diagnostic(`SWPCHN0001 children after the restart: ${channels.join(' ')}`);
            t.diagnostic(`the truncated SWPBAD0001: ${list.includes('SWPBAD0001') ? 'loaded' : 'dropped'}`);
            assert.ok(second.alive);
            assert.deepEqual(second.sanitizerReports(), []);
        });
    },
);

test(
    'rfd address donation: with BidCoS-Address = 0 rfd takes the module default address and writes it to the address file',
    options(),
    async (t) => {
        const rfd = await startRfd({address: 0, module: {defaultRfAddress: 0x2c3d4e}});
        await withDaemon(rfd, async () => {
            assert.ok(rfd.grep(/Got BidCoS-Address donation: 0x2C3D4E/i).length >= 1, rfd.tail(30));
            const ids = fs.readFileSync(path.join(rfd.workdir, 'ids'), 'utf8');
            t.diagnostic(`address file: ${ids.trim()}`);
            assert.match(ids, /BidCoS-Address\s*=\s*(2899278|0x2C3D4E)/i, 'persisted');
            assert.equal(rfd.module.rfAddress, 0x2c3d4e, 'and set in the module');
        });
    },
);

test(
    'rfd receiver persistence: a registered receiver is called again after a restart, without a new init',
    options(),
    async (t) => {
        const receiver = await startReceiver();
        const first = await startRfd();
        const dir = first.workdir;
        try {
            await withDaemon(first, async () => {
                await first.call('init', [receiver.url, 'persist']);
                await receiver.waitFor('newDevices', 15000);
                assert.ok(fs.readFileSync(path.join(dir, 'rfd.handlers'), 'utf8').includes(receiver.url));
                assert.ok(await first.exitViaRpc(), 'rfd ended');
            });
            const from = receiver.received.length;
            const second = await startRfd({dir});
            await withDaemon(second, async () => {
                await second.call('ping', ['after-restart']);
                const until = Date.now() + 10000;
                let found = null;
                while (!found && Date.now() < until) {
                    found = receiver.received
                        .slice(from)
                        .find((r) => r.method === 'event' && r.params[2] === 'PONG' && r.params[3] === 'after-restart');
                    await sleep(100);
                }
                t.diagnostic(
                    `after the restart the receiver got: ${receiver.received
                        .slice(from)
                        .map((r) => r.method)
                        .join(' ')}`,
                );
                assert.ok(found, 'PONG reached the persisted receiver');
                assert.equal(found.params[0], 'persist', 'with its id from the handlers file');
            });
        } finally {
            await receiver.stop();
        }
    },
);

test(
    'rfd key file: changeKey writes the new key and index to the key file, a restart loads them (Persist Keys = 1)',
    options(),
    async (t) => {
        const first = await startQuietRfd();
        const dir = first.workdir;
        const keys = () => fs.readFileSync(path.join(dir, 'keys'), 'utf8');
        const before = keys();
        await withDaemon(first, async () => {
            await first.call('changeKey', ['restart-test-passphrase'], {timeout: 30000});
            const until = Date.now() + 10000;
            while (keys() === before && Date.now() < until) {
                await sleep(200);
            }
            t.diagnostic(
                `key file after changeKey: ${keys()
                    .replace(/Key (\d+) = [0-9A-Fa-f]+/g, 'Key $1 = <key>')
                    .trim()}`,
            );
            assert.match(keys(), /Current Index\s*=\s*2/, 'the index moved on');
            assert.match(keys(), /Key 2\s*=\s*[0-9A-Fa-f]{32}/, 'the new key is stored');
            assert.ok(await first.exitViaRpc(), 'rfd ended');
        });
        const second = await startQuietRfd({dir});
        await withDaemon(second, async () => {
            assert.ok(second.grep(/Current AES key=2, previous AES key=1/).length >= 1, second.tail(30));
        });
    },
);

test('rfd -f with a missing config file: it says so and does not run', options(), async (t) => {
    const rfd = await spawnRfd({args: ['-f', '/nonexistent/rfd.conf', '-c', '-l', '0']});
    try {
        const exit = await exitWithin(rfd, 20000);
        t.diagnostic(`exit ${JSON.stringify(exit)}; log: ${rfd.log.slice(0, 6).join(' | ')}`);
        assert.ok(exit, 'rfd ended');
        assert.equal(exit.signal, null, 'no crash');
        assert.ok(rfd.grep(/Error reading config file/).length >= 1, rfd.tail());
    } finally {
        await rfd.stop();
    }
});

test(
    'rfd with an unknown interface Type: no interface, rfd does not run (and does not crash)',
    options(),
    async (t) => {
        const rfd = await spawnRfd({interfaces: [{type: 'NO-SUCH-TYPE', serial: 'SIM0000001'}]});
        try {
            const exit = await exitWithin(rfd, 20000);
            t.diagnostic(
                `exit ${JSON.stringify(exit)}; ${rfd
                    .grep(/Interface|Type/i)
                    .slice(0, 4)
                    .join(' | ')}`,
            );
            assert.ok(exit, 'rfd ended');
            assert.equal(exit.signal, null, 'no crash');
            assert.ok(rfd.grep(/No BidCoS-Interface available/).length >= 1, rfd.tail());
        } finally {
            await rfd.stop();
        }
    },
);

test(
    'rfd log destinations: File writes to Log Filename, None writes nothing; RPC works either way',
    options(),
    async (t) => {
        const logDir = tmpdir('hmrs-log');
        const logFile = path.join(logDir, 'sub', 'rfd-file.log');
        const viaFile = await startRfd({console: false, logDestination: 'File', extra: `Log Filename = ${logFile}`});
        await withDaemon(viaFile, async () => {
            assert.ok(Array.isArray(await viaFile.call('listDevices')));
            assert.ok(fs.existsSync(logFile), 'the log file (and its directory) was created');
            assert.match(fs.readFileSync(logFile, 'utf8'), /BidCoS-Service started/);
            assert.equal(viaFile.grep(/BidCoS-Service started/).length, 0, 'nothing of it on the console');
        });
        const silent = await startRfd({console: false, logDestination: 'None'});
        await withDaemon(silent, async () => {
            assert.ok(Array.isArray(await silent.call('listDevices')));
            t.diagnostic(`console lines with Log Destination = None: ${silent.log.length}`);
            assert.equal(silent.grep(/BidCoS-Service started|<Info>|<Debug>/).length, 0, 'no log lines');
        });
    },
);

test('rfd UDS File: the same RPC server on a unix-domain socket', options(), async () => {
    const dir = tmpdir('hmrs-uds');
    const socketPath = path.join(dir, 'rfd.sock');
    const rfd = await startRfd({extra: `UDS File = ${socketPath}`});
    await withDaemon(rfd, async () => {
        assert.ok(fs.existsSync(socketPath), 'the socket exists');
        const body =
            '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName><params></params></methodCall>';
        const answer = await new Promise((resolve, reject) => {
            const req = http.request(
                {socketPath, method: 'POST', path: '/', headers: {'Content-Type': 'text/xml'}},
                (res) => {
                    let text = '';
                    res.on('data', (c) => (text += c));
                    res.on('end', () => resolve({status: res.statusCode, text}));
                },
            );
            req.on('error', reject);
            req.setTimeout(10000, () => req.destroy(new Error('no answer on the socket')));
            req.end(body);
        });
        assert.equal(answer.status, 200);
        assert.match(answer.text, /listDevices/);
    });
});

test('rfd with its port taken: "Could not bind", exit 0', options(), async () => {
    const port = await freePort();
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
    const rfd = await spawnRfd({port});
    try {
        const exit = await exitWithin(rfd, 20000);
        assert.ok(exit, 'rfd ended');
        assert.equal(exit.code, 0, 'the exit code is 0 here, as for the other start-up errors');
        assert.ok(rfd.grep(new RegExp(`Could not bind to TCP port ${port}`)).length >= 1, rfd.tail());
    } finally {
        await rfd.stop();
        await new Promise((resolve) => blocker.close(resolve));
    }
});

test(
    'rfd with two interfaces: two simulated modules, both listed and connected, one of them the default',
    options(),
    async (t) => {
        const dir = tmpdir('hmrs-two');
        const modules = [new RadioModule({serial: 'SIM0000001'}), new RadioModule({serial: 'SIM0000002'})];
        const ptys = [];
        for (const [i, module] of modules.entries()) {
            ptys.push(await createPtyModule({module, link: path.join(dir, `uart${i}`)}));
        }
        try {
            const rfd = await spawnRfd({interfaces: ptys.map((p) => ({type: 'CCU2', dev: p.link}))});
            await rfd.waitReady();
            await withDaemon(rfd, async () => {
                let interfaces = [];
                const until = Date.now() + 30000;
                while (Date.now() < until) {
                    interfaces = await rfd.call('listBidcosInterfaces');
                    if (interfaces.length === 2 && interfaces.every((i) => i.CONNECTED)) {
                        break;
                    }
                    await sleep(500);
                }
                t.diagnostic(JSON.stringify(interfaces));
                assert.deepEqual(interfaces.map((i) => i.ADDRESS).sort(), ['SIM0000001', 'SIM0000002']);
                assert.ok(
                    interfaces.every((i) => i.CONNECTED),
                    'both connected',
                );
                assert.equal(interfaces.filter((i) => i.DEFAULT).length, 1, 'exactly one default');
                for (const module of modules) {
                    assert.ok(module.rfAddress !== null, `${module.serial} got the central address`);
                }
            });
        } finally {
            for (const p of ptys) {
                await p.close();
            }
            for (const m of modules) {
                m.close();
            }
        }
    },
);

test(
    'rfd with the legacy coprocessor initialisation (Improved Coprocessor Initialization = false) gets its interface connected',
    options(),
    async (t) => {
        const rfd = await startRfd({improvedInit: false});
        await withDaemon(rfd, async () => {
            let interfaces = [];
            const until = Date.now() + 30000;
            while (Date.now() < until) {
                interfaces = await rfd.call('listBidcosInterfaces');
                if (interfaces[0] && interfaces[0].CONNECTED) {
                    break;
                }
                await sleep(500);
            }
            t.diagnostic(`module saw: ${rfd.module.commands.map((c) => c.name).join(' ')}`);
            assert.equal(interfaces[0].CONNECTED, true);
        });
    },
);

test('rfd in sniffing mode (-s): starts without the device model and still answers RPC', options(), async (t) => {
    const rfd = await spawnRfd({args: ['-f', '{config}', '-c', '-l', '0', '-s']});
    await rfd.waitReady().catch((error) => {
        t.diagnostic(error.message.slice(0, 400));
    });
    await withDaemon(rfd, async () => {
        t.diagnostic(
            `alive ${rfd.alive}; ${rfd
                .grep(/sniff|Logging|BidCoS-Service/i)
                .slice(0, 4)
                .join(' | ')}`,
        );
        assert.ok(rfd.alive, `rfd -s ended: ${JSON.stringify(rfd.exit)}\n${rfd.tail()}`);
        assert.ok(Array.isArray(await rfd.call('system.listMethods')));
        assert.deepEqual(rfd.sanitizerReports(), []);
    });
});

/** Every hs485types type with a condition as a wired device, as in the type sweep. */
function wiredDevices() {
    const devices = [];
    let i = 0;
    for (const file of fs
        .readdirSync(HS485TYPES)
        .filter((f) => f.endsWith('.xml'))
        .sort()) {
        const description = loadDeviceDescription(path.join(HS485TYPES, file));
        for (const type of description.types) {
            if (!type.conditions.some((c) => c.index)) {
                continue;
            }
            i++;
            devices.push(
                new WiredDevice({
                    address: 0x00006000 + i,
                    serial: `SWX${String(i).padStart(7, '0')}`,
                    description,
                    typeId: type.id,
                    sysinfo: sysinfoSatisfying(description, type.id, Buffer.alloc(4)),
                }),
            );
        }
    }
    return devices;
}

test(
    'hs485d restart: every wired type comes back from its file with the same address, type, version and channels',
    options(),
    async (t) => {
        const devices = wiredDevices();
        const bus = new WiredBus();
        devices.forEach((d) => bus.add(d));
        const first = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus});
        const dir = first.dir;
        let before;
        await withDaemon(first, async () => {
            assert.equal(await first.call('searchDevices', [], {timeout: 300000}), devices.length);
            await sleep(2000);
            before = await snapshot(first);
        });
        const second = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus, dir});
        await withDaemon(second, async () => {
            const after = await snapshot(second);
            const missing = before.filter((x) => !after.includes(x));
            const extra = after.filter((x) => !before.includes(x));
            t.diagnostic(
                `${devices.length} devices, ${after.length} addresses; missing ${missing.length}, new ${extra.length}`,
            );
            assert.deepEqual({missing, extra}, {missing: [], extra: []});
            assert.deepEqual(second.sanitizerReports(), []);
        });
    },
);

test(
    'hs485d reads extra descriptions from /etc/config/hs485types: a type only described there is discovered as that type',
    options(),
    async (t) => {
        const userDir = '/etc/config/hs485types';
        try {
            fs.mkdirSync(userDir, {recursive: true});
            fs.accessSync(userDir, fs.constants.W_OK);
        } catch {
            t.skip(`${userDir} is not writable here (the test runs as root in the image)`);
            return;
        }
        // the suite's own wired fixture, given a type code no shipped description has (0x7a)
        const fixture = new URL('../fixtures/hs485types/sim_wired_switch.xml', import.meta.url).pathname;
        const xml = fs
            .readFileSync(fixture, 'latin1')
            .replace('id="SIM-HMW-Sw2"', 'id="SIM-HMW-USER"')
            .replace('const_value="17"', 'const_value="122"');
        const file = path.join(userDir, 'hmrs_user_type.xml');
        fs.writeFileSync(file, xml, 'latin1');
        try {
            const description = loadDeviceDescription(file);
            const bus = new WiredBus();
            bus.add(
                new WiredDevice({
                    address: 0x00007001,
                    serial: 'SIMUSER001',
                    description,
                    typeId: 'SIM-HMW-USER',
                    sysinfo: [122, 0, 0x03, 0x03],
                }),
            );
            const hs485d = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus});
            await withDaemon(hs485d, async () => {
                assert.equal(await hs485d.call('searchDevices', [], {timeout: 60000}), 1);
                const d = await hs485d.call('getDeviceDescription', ['SIMUSER001']);
                t.diagnostic(`type ${d.TYPE}, children ${d.CHILDREN.join(' ')}`);
                assert.equal(d.TYPE, 'SIM-HMW-USER');
            });
        } finally {
            fs.rmSync(file, {force: true});
        }
    },
);
