/**
 * Link registers rfd writes from the rftypes descriptions - OpenCCU-Base #63 (661be9e8): the HM-OU-CFM-TW chime's
 * signal-LED link paramset had LONG_ACT_TYPE on register 0x24, the register of SHORT_ACT_TYPE, so writing the long
 * action overwrote the short one; the fix moved it to 0xA4. The device-type sweep loads the CFM-TW but writes no link
 * register, so only a link with a peer shows it.
 *
 * Timing assumptions: the CFM-TW is a burst device (rx_modes BURST; rfd's BURST_ACTIVE_INTERVAL 1800 ms, the
 * simulated device stays awake 2000 ms after a burst - chosen); rfd's telegram window 4000 ms (defaultResponseTimeout).
 * Waits here are up to 60 s.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {startRfd, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {regression} from '../helpers/known.js';
import {startReceiver} from '../helpers/rpc.js';
import {
    airOf,
    attachRemote,
    description,
    pairDevice,
    waitForValue,
    REMOTE_SERIAL,
    REMOTE_ADDRESS,
} from '../helpers/switch.js';
import {BidcosDevice} from '../../lib/device.js';

const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 300000, ...extra});
const CFM_SERIAL = 'SIMCFM0001';
const CFM_ADDRESS = 0x3a4b5c;
const RC1 = `${REMOTE_SERIAL}:1`;
const CFM1 = `${CFM_SERIAL}:1`;

test(
    "HM-OU-CFM-TW: a link's LONG_ACT_TYPE is written to register 0xA4, SHORT_ACT_TYPE stays on 0x24 (#63)",
    options(),
    async (t) => {
        const rfd = await startRfd();
        const receiver = await startReceiver();
        await withDaemon(rfd, async () => {
            await rfd.call('init', [receiver.url, 'hmrs']);
            await receiver.waitFor('newDevices', 15000);
            const air = airOf(rfd);
            const cfm = air.add(
                new BidcosDevice({
                    address: CFM_ADDRESS,
                    serial: CFM_SERIAL,
                    description: description('rf_cfm_tw.xml'),
                    typeId: 'HM-OU-CFM-TW',
                    rxMode: 'burst',
                    channelCount: 2,
                }),
            );
            const {device: rc} = attachRemote(rfd);
            await pairDevice(rfd, receiver, air, cfm, {timeout: 60000});
            await pairDevice(rfd, receiver, air, rc);
            await rfd.call('addLink', [RC1, CFM1, 'key to chime LED', ''], {timeout: 60000});
            await waitForValue(rfd, `${CFM_SERIAL}:0`, 'CONFIG_PENDING', false, 60000);
            const description1 = await rfd.call('getParamsetDescription', [CFM1, 'LINK']);
            t.diagnostic(
                `LINK paramset: SHORT_ACT_TYPE ${JSON.stringify(description1.SHORT_ACT_TYPE?.VALUE_LIST?.length)} options, LONG_ACT_TYPE ${JSON.stringify(description1.LONG_ACT_TYPE?.VALUE_LIST?.length)} options`,
            );
            // SHORT_ACT_TYPE = GREEN_SHORT (3, device value 0x21), LONG_ACT_TYPE = BLUE_LONG (8, device value 0x42)
            await rfd.call('putParamset', [CFM1, RC1, {SHORT_ACT_TYPE: 3, LONG_ACT_TYPE: 8}], {timeout: 60000});
            await waitForValue(rfd, `${CFM_SERIAL}:0`, 'CONFIG_PENDING', false, 60000);
            const list3 = cfm.list(1, 3, REMOTE_ADDRESS, 1);
            const reg = (r) => (list3.has(r) ? `0x${list3.get(r).toString(16).padStart(2, '0')}` : 'unset');
            t.diagnostic(`list 3 for the remote's key on the chime LED: 0x24=${reg(0x24)}, 0xA4=${reg(0xa4)}`);
            const back = await rfd.call('getParamset', [CFM1, RC1]);
            t.diagnostic(`getParamset: SHORT_ACT_TYPE ${back.SHORT_ACT_TYPE}, LONG_ACT_TYPE ${back.LONG_ACT_TYPE}`);
            assert.ok(list3.size > 0, 'rfd wrote list 3 for the link');
            await t.test('the long action on 0xA4, the short one kept on 0x24', regression(63), () => {
                assert.equal(reg(0x24), '0x21', 'SHORT_ACT_TYPE on 0x24');
                assert.equal(reg(0xa4), '0x42', 'LONG_ACT_TYPE on 0xA4');
            });
        }).finally(() => receiver.stop());
    },
);
