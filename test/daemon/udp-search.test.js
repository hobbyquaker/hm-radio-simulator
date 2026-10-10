/**
 * Stage 4: the UDP device search of libLanDeviceUtils, which both daemons run when a LAN gateway is configured by its
 * serial only - rfd for `Type = HMLGW2` without `IP Address`, hs485d for `-g -s <serial>` and on every HMW-LGW
 * reconnect. A simulated eQ-3 LAN device (lib/eq3udp.js) answers on UDP 43439 with the gateway's address; the
 * daemons then connect to the fixed ports (rfd 2000/2001, hs485d 1000).
 *
 * Timing (libLanDeviceUtils): the identify broadcast waits 2000 ms for answers (UDPDatagramSender::send with
 * maxResponseCount 1000), the runtime-IP request 2000 ms for one answer; hs485d sleeps 65 s and retries when the
 * search fails at start (failureSleepTime), so a missing answer is not tested here.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {startRfd, startHs485d, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {createEq3LanDevice} from '../../lib/eq3udp.js';
import {WiredBus, WiredDevice} from '../../lib/wired.js';
import {loadDeviceDescription} from '../../lib/rftypes.js';
import {HS485TYPES} from '../helpers/daemon.js';
import path from 'node:path';

const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 240000, ...extra});

test(
    'rfd: HMLGW2 by serial only - the UDP identify and runtime-IP requests, then the gateway on 2000/2001',
    options(),
    async (t) => {
        const lanDevice = await createEq3LanDevice({
            type: 'eQ3-HM-LGW',
            serial: 'SIM0000002',
            ip: '127.0.0.1',
            services: [[1, 2000]],
        });
        try {
            const started = Date.now();
            const rfd = await startRfd({lgwFront: {serial: 'SIM0000002', key: 'TestLanKey-1234', search: true}});
            await withDaemon(rfd, async () => {
                t.diagnostic(`rfd found the gateway and connected ${Date.now() - started} ms after the start`);
                t.diagnostic(
                    `UDP requests: ${lanDevice.requests.map((r) => `${r.opcode} ${r.typeFilter || '*'} ${r.serial} ${r.answered ? 'answered' : '-'}`).join(', ')}`,
                );
                assert.ok(
                    lanDevice.requests.some((r) => r.opcode === 'I' && r.typeFilter === 'eQ3-HM-LGW*' && r.answered),
                );
                assert.ok(lanDevice.requests.some((r) => r.opcode === 'n' && r.answered));
                const interfaces = await rfd.call('listBidcosInterfaces');
                assert.equal(interfaces[0].CONNECTED, true);
                assert.equal(interfaces[0].ADDRESS, 'SIM0000002');
                assert.ok(rfd.grep(/Serial Number: SIM0000002/).length >= 1);
                assert.equal(rfd.module.commands[0].name, 'IDENTIFY');
            });
        } finally {
            await lanDevice.close();
        }
    },
);

test(
    'hs485d: -g -s <serial> - the search over UDP, then the HMW-LGW on port 1000 and a device on the bus',
    options(),
    async (t) => {
        const lanDevice = await createEq3LanDevice({
            type: 'eQ3-HMW-LGW',
            serial: 'SIMWLGW001',
            ip: '127.0.0.1',
            services: [[1, 1000]],
        });
        const bus = new WiredBus();
        bus.add(
            new WiredDevice({
                address: 0x00004711,
                serial: 'SIMW000001',
                description: loadDeviceDescription(path.join(HS485TYPES, 'hmw_lc_sw2_dr.xml')),
                typeId: 'HMW-LC-Sw2-DR',
                sysinfo: [0x11, 0x00, 0x03, 0x05],
            }),
        );
        try {
            const started = Date.now();
            const hs485d = await startHs485d({lgwFront: {serial: 'SIMWLGW001'}, bus, searchSerial: 'SIMWLGW001'});
            await withDaemon(hs485d, async () => {
                t.diagnostic(`hs485d found the gateway and connected ${Date.now() - started} ms after the start`);
                assert.equal(hs485d.lgw.port, 1000);
                assert.ok(
                    lanDevice.requests.some((r) => r.opcode === 'I' && r.typeFilter === 'eQ3-HMW-LGW*' && r.answered),
                );
                assert.ok(lanDevice.requests.some((r) => r.opcode === 'n' && r.answered));
                assert.ok(hs485d.grep(/Serial Number: SIMWLGW001/).length >= 1);
                assert.equal(await hs485d.call('searchDevices', [], {timeout: 60000}), 1);
                const devices = await hs485d.call('listDevices');
                assert.ok(devices.some((d) => d.ADDRESS === 'SIMW000001'));
            });
        } finally {
            await lanDevice.close();
        }
    },
);
