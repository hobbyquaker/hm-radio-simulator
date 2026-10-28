/**
 * Value limits rfd reports from the rftypes descriptions - OpenCCU-Base #221 (87a32d29): the radiator thermostat
 * HM-CC-RT-DN-BoM (rf_cc_rt_dn_bom.xml) described SET_TEMPERATURE of its thermostat channel 4 and the link parameters
 * SHORT_/LONG_TEMPERATUR_RC of its remote-control receiver channel 6 with 5.0-30.0 °C, while the standard HM-CC-RT-DN
 * (rf_cc_rt_dn.xml) and the device itself use 4.5 (OFF) to 30.5 (ON); an integration that validates against the
 * paramset description refused the 30.5 the thermostat reports. The fix sets 4.5/30.5 on all three.
 *
 * Not tested here: the other half of #221, HMServer's opt/HMServer/groups/groupdefinitions.xml (the heating group
 * HM-CC-VG-1) - HMServer is not part of this suite.
 *
 * Timing assumptions: the thermostat is a burst device (rx_modes CONFIG,BURST; rfd's BURST_ACTIVE_INTERVAL 1800 ms, the
 * simulated device stays awake 2000 ms after a burst - chosen); rfd's telegram window 4000 ms (defaultResponseTimeout).
 * The pairing waits up to 60 s.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {startRfd, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {regression} from '../helpers/known.js';
import {startReceiver} from '../helpers/rpc.js';
import {airOf, description, pairDevice} from '../helpers/switch.js';
import {BidcosDevice} from '../../lib/device.js';

const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 300000, ...extra});
const RT_SERIAL = 'SIMRTB0001';
const RT_ADDRESS = 0x4b5c6d;
const RT_TYPE = 'HM-CC-RT-DN-BoM';

/** A float limit as rfd reports it (a double over XML-RPC/BIN-RPC), compared with a margin for its representation. */
function assertLimit(actual, expected, what) {
    assert.equal(typeof actual, 'number', `${what} is a number (got ${JSON.stringify(actual)})`);
    assert.ok(Math.abs(actual - expected) < 1e-6, `${what} is ${expected} (got ${actual})`);
}

test(
    'HM-CC-RT-DN-BoM: SET_TEMPERATURE and the TEMPERATUR_RC link parameters range from 4.5 to 30.5 (#221)',
    options(),
    async (t) => {
        const rfd = await startRfd();
        const receiver = await startReceiver();
        await withDaemon(rfd, async () => {
            await rfd.call('init', [receiver.url, 'hmrs']);
            await receiver.waitFor('newDevices', 15000);
            const air = airOf(rfd);
            const rt = air.add(
                new BidcosDevice({
                    address: RT_ADDRESS,
                    serial: RT_SERIAL,
                    description: description('rf_cc_rt_dn_bom.xml'),
                    typeId: RT_TYPE,
                    rxMode: 'burst',
                }),
            );
            await pairDevice(rfd, receiver, air, rt, {timeout: 60000});
            const device = await rfd.call('getDeviceDescription', [RT_SERIAL]);
            assert.equal(device.TYPE, RT_TYPE, 'rfd took the announcement for an HM-CC-RT-DN-BoM');
            const values = await rfd.call('getParamsetDescription', [`${RT_SERIAL}:4`, 'VALUES']);
            const link = await rfd.call('getParamsetDescription', [`${RT_SERIAL}:6`, 'LINK']);
            const range = (p) => (p ? `${p.MIN}..${p.MAX}` : 'missing');
            t.diagnostic(
                `channel 4 VALUES SET_TEMPERATURE ${range(values.SET_TEMPERATURE)}; channel 6 LINK SHORT_TEMPERATUR_RC ${range(link.SHORT_TEMPERATUR_RC)}, LONG_TEMPERATUR_RC ${range(link.LONG_TEMPERATUR_RC)}`,
            );
            assert.ok(values.SET_TEMPERATURE, 'channel 4 has SET_TEMPERATURE');
            assert.ok(
                link.SHORT_TEMPERATUR_RC && link.LONG_TEMPERATUR_RC,
                'channel 6 has the TEMPERATUR_RC link parameters',
            );
            await t.test('SET_TEMPERATURE of channel 4 from 4.5 to 30.5', regression(221), () => {
                assertLimit(values.SET_TEMPERATURE.MIN, 4.5, 'MIN');
                assertLimit(values.SET_TEMPERATURE.MAX, 30.5, 'MAX');
            });
            await t.test('SHORT_ and LONG_TEMPERATUR_RC of channel 6 from 4.5 to 30.5', regression(221), () => {
                for (const id of ['SHORT_TEMPERATUR_RC', 'LONG_TEMPERATUR_RC']) {
                    assertLimit(link[id].MIN, 4.5, `${id} MIN`);
                    assertLimit(link[id].MAX, 30.5, `${id} MAX`);
                }
            });
        }).finally(() => receiver.stop());
    },
);
