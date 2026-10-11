/**
 * Stage 2: one simulated switch (HM-LC-Sw1-Pl, driven by the image's rf_s.xml) behind the module on the pty. Concept
 * cases 6, 7, 8, 13 and 14: pairing in install mode, a set and its acknowledgement, a status report, UNREACH,
 * CONFIG_PENDING, the duty cycle, and the events on a BIN-RPC and an XML-RPC receiver.
 *
 * Timing assumptions (rfd 3.89.11): a sent telegram's status comes within defaultResponseTimeout = 4000 ms (the
 * simulated air answers after ackDelayMs = 155 ms (measured) and reports a silent device as SEND_FAILED after failDelayMs =
 * 1106 ms - both measured on a real module); after a send rfd waits WAIT_TIME_DEFAULT = 1500 ms for further responses;
 * after a failed send it refuses the next one for FAIL_COUNTER_RESET_TIME = 5000 ms; a pending configuration is
 * retried after 5 and 10 s (RFDevice::ScheduleConfigRetry). The install mode lasts 60 s. Every wait here has a margin
 * of seconds.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {startRfd, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {startReceiver} from '../helpers/rpc.js';
import {
    attachSwitch,
    pairSwitch,
    waitForValue,
    waitForEvent,
    eventValues,
    SWITCH_SERIAL,
    SWITCH_ADDRESS,
} from '../helpers/switch.js';
import {BIDCOS_STATUS} from '../../lib/commands.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 240000, ...extra});
const CH0 = `${SWITCH_SERIAL}:0`;
const CH1 = `${SWITCH_SERIAL}:1`;

/** rfd with a receiver registered and the switch on the air, not yet paired. */
async function setup(t, {protocol = 'binrpc', device = {}} = {}) {
    const rfd = await startRfd();
    const receiver = await startReceiver({protocol});
    const {air, device: sw} = attachSwitch(rfd, device);
    await rfd.call('init', [receiver.url, 'hmrs']);
    await receiver.waitFor('newDevices', 15000); // the central
    const cleanup = async () => {
        t.diagnostic(`trace: ${air.traceLines().join(' > ')}`);
        await receiver.stop();
    };
    return {rfd, receiver, air, sw, cleanup};
}

/** A call that may fault: binrpc hands a fault back as an error or as the fault struct, depending on its version. */
async function faultOrResult(promise) {
    return promise.then(
        (result) => (result && typeof result === 'object' && 'faultCode' in result ? {fault: result} : {result}),
        (error) => ({fault: error}),
    );
}

test(
    'pairing: install mode, the device announces itself, rfd configures it and reports newDevices',
    options(),
    async (t) => {
        const {rfd, receiver, air, sw, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const {newDevices} = await pairSwitch(rfd, receiver, air, sw);
            const announced = newDevices.params[1];
            const device = announced.find((d) => d.ADDRESS === SWITCH_SERIAL);
            const channel = announced.find((d) => d.ADDRESS === CH1);
            assert.ok(device && channel, JSON.stringify(announced.map((d) => d.ADDRESS)));
            assert.equal(device.TYPE, 'HM-LC-Sw1-Pl', 'rfd picked the type from the sysinfo (0x0011, firmware 2.4)');
            assert.equal(channel.TYPE, 'SWITCH');
            assert.equal(channel.PARENT, SWITCH_SERIAL);
            assert.equal(device.FIRMWARE, '2.4');
            assert.ok(device.CHILDREN.includes(CH0) && device.CHILDREN.includes(CH1), JSON.stringify(device.CHILDREN));

            // what rfd wrote into the device: list 0 of channel 0 with the central's address and "manual pairing off"
            assert.equal(sw.pairedCentral(), rfd.module.rfAddress, 'the central address at list 0 index 10..12');
            assert.equal(sw.list(0, 0).get(2) & 0x01, 1, 'bit 0 of index 2');
            const names = air.traceLines();
            for (const name of [
                'tx CONFIG_START',
                'tx CONFIG_WRITE_INDEX',
                'tx CONFIG_END',
                'tx CONFIG_PARAM_REQ',
                'tx CONFIG_PEER_LIST_REQ',
                'tx AES_CONTAINER',
            ]) {
                assert.ok(
                    names.some((n) => n.startsWith(name)),
                    `${name} in ${names.join(' | ')}`,
                );
            }
            // the module knows the device now: ADD_LINK_PEER; its answer carried the authentication mask (all
            // channels off), which equals what rfd wants for a switch without AES_ACTIVE, so rfd sends no
            // AUTHENTICATION_ON/OFF at all (CCU2BidcosRemoteInterface::SetDeviceAesPolicy compares the two masks)
            assert.ok(rfd.module.peers.has(SWITCH_ADDRESS), 'ADD_LINK_PEER for the device');
            assert.ok(
                !rfd.module.authentication.has(SWITCH_ADDRESS),
                'no AUTHENTICATION_ON/OFF for a device without AES',
            );

            const devices = await rfd.call('listDevices');
            assert.ok(devices.some((d) => d.ADDRESS === SWITCH_SERIAL) && devices.some((d) => d.ADDRESS === CH1));
            assert.equal(await rfd.call('getValue', [CH0, 'UNREACH']), false);
            assert.equal(await rfd.call('getValue', [CH0, 'CONFIG_PENDING']), false);
            const master = await rfd.call('getParamset', [CH1, 'MASTER']);
            assert.equal(master.TRANSMIT_TRY_MAX, 0, 'read back from the device, whose list 1 is empty');
        }).finally(cleanup);
    },
);

test(
    'a set and its acknowledgement: setValue STATE true switches the device, ACK_STATUS becomes the event',
    options(),
    async (t) => {
        const {rfd, receiver, air, sw, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            await pairSwitch(rfd, receiver, air, sw);
            const from = receiver.received.length;
            await rfd.call('setValue', [CH1, 'STATE', true]);
            assert.equal(sw.behaviour.channel(1).STATE, 200, 'LEVEL_SET reached the device');
            const event = await waitForEvent(receiver, CH1, 'STATE', true, {from});
            assert.equal(event.params[0], 'hmrs', 'the interface id given to init');
            assert.equal(await rfd.call('getValue', [CH1, 'STATE']), true);
            assert.equal(await rfd.call('getValue', [CH1, 'WORKING']), false);
            assert.ok(
                air.traceLines().some((n) => n.startsWith('tx LEVEL_SET ch1 STATE=200')),
                air.traceLines().join(' | '),
            );
            assert.ok(
                air.traceLines().some((n) => n.startsWith('rx ACK_STATUS ch1 STATE=200')),
                air.traceLines().join(' | '),
            );

            await rfd.call('setValue', [CH1, 'STATE', false]);
            await waitForEvent(receiver, CH1, 'STATE', false, {from});
            assert.equal(sw.behaviour.channel(1).STATE, 0);
            // a set with a stored ON_TIME: rf_s.xml spells the frame parameter PARAM="ON_TIME" - what rfd puts into the
            // LEVEL_SET is recorded, not asserted (measured on 3.89.11: the frame carries ON_TIME=0, i.e. no time)
            await rfd.call('setValue', [CH1, 'ON_TIME', 30.0]);
            await rfd.call('setValue', [CH1, 'STATE', true]);
            t.diagnostic(
                `LEVEL_SET after ON_TIME 30 s: ${air.traceLines().findLast((n) => n.startsWith('tx LEVEL_SET'))}`,
            );
            assert.equal(rfd.module.stats.crcErrors, 0);
        }).finally(cleanup);
    },
);

test('a status report from the device becomes an event; rfd acknowledges it', options(), async (t) => {
    const {rfd, receiver, air, sw, cleanup} = await setup(t);
    await withDaemon(rfd, async () => {
        await pairSwitch(rfd, receiver, air, sw);
        const from = receiver.received.length;
        sw.behaviour.channel(1).STATE = 200;
        air.reportStatus(sw, 1);
        await waitForEvent(receiver, CH1, 'STATE', true, {from});
        assert.equal(await rfd.call('getValue', [CH1, 'STATE']), true);
        // the report asked for an acknowledgement (bidi); rfd itself sends none - on real hardware the module
        // firmware acknowledges for the devices in its link-peer table (ADD_LINK_PEER), which is why rfd adds them
        await sleep(500);
        assert.ok(
            !air.traceLines().slice(-1)[0].startsWith('tx'),
            `rfd did not answer the report itself: ${air.traceLines().slice(-3).join(' | ')}`,
        );
        // a RSSI value arrived with the report
        const rssi = await rfd.call('getValue', [CH0, 'RSSI_DEVICE']);
        assert.ok(typeof rssi === 'number' && rssi < 0, `RSSI_DEVICE ${rssi}`);
    }).finally(cleanup);
});

test(
    'UNREACH: a silent device fails the set, UNREACH and STICKY_UNREACH go up; the device returns, UNREACH goes down',
    options(),
    async (t) => {
        const {rfd, receiver, air, sw, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            await pairSwitch(rfd, receiver, air, sw);
            const from = receiver.received.length;
            sw.answering = false;
            const started = Date.now();
            const outcome = await faultOrResult(rfd.call('setValue', [CH1, 'STATE', true], {timeout: 30000}));
            t.diagnostic(
                `the failed set returned after ${Date.now() - started} ms: ${JSON.stringify(outcome).slice(0, 120)}`,
            );
            assert.ok(outcome.fault, 'setValue to a silent device faults');
            await waitForEvent(receiver, CH0, 'UNREACH', true, {from});
            await waitForEvent(receiver, CH0, 'STICKY_UNREACH', true, {from});
            assert.equal(await rfd.call('getValue', [CH0, 'UNREACH']), true);
            const messages = await rfd.call('getServiceMessages');
            assert.ok(
                messages.some((m) => m[0] === CH0 && m[1] === 'UNREACH' && m[2] === true),
                `service messages: ${JSON.stringify(messages)}`,
            );
            assert.ok(air.traceLines().filter((n) => n.startsWith('tx LEVEL_SET')).length >= 1);

            // the device is back and reports its status: UNREACH clears, STICKY_UNREACH stays until it is reset
            sw.answering = true;
            const from2 = receiver.received.length;
            air.reportStatus(sw, 1);
            await waitForEvent(receiver, CH0, 'UNREACH', false, {from: from2});
            assert.equal(await rfd.call('getValue', [CH0, 'STICKY_UNREACH']), true, 'sticky until reset');
            await rfd.call('setValue', [CH0, 'STICKY_UNREACH', false]);
            assert.equal(await rfd.call('getValue', [CH0, 'STICKY_UNREACH']), false);
            // rfd refuses sends for FAIL_COUNTER_RESET_TIME (5 s) after the failure; after that a set works again
            await sleep(5500);
            await rfd.call('setValue', [CH1, 'STATE', true]);
            assert.equal(sw.behaviour.channel(1).STATE, 200);
        }).finally(cleanup);
    },
);

test(
    'CONFIG_PENDING: a MASTER parameter for a silent device stays pending and is delivered when it answers',
    options(),
    async (t) => {
        const {rfd, receiver, air, sw, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            await pairSwitch(rfd, receiver, air, sw);
            const from = receiver.received.length;
            sw.answering = false;
            const outcome = await faultOrResult(
                rfd.call('putParamset', [CH1, 'MASTER', {TRANSMIT_TRY_MAX: 5}], {timeout: 60000}),
            );
            t.diagnostic(`putParamset to the silent device: ${JSON.stringify(outcome).slice(0, 120)}`);
            await waitForEvent(receiver, CH0, 'CONFIG_PENDING', true, {from, timeout: 30000});
            assert.equal(await rfd.call('getValue', [CH0, 'CONFIG_PENDING']), true);
            assert.notEqual(sw.list(1, 1).get(48), 5, 'nothing reached the device yet');

            // the device is back: a status report lets rfd deliver the pending configuration (and its retry timer would
            // too, 5 and 10 s after the failure)
            sw.answering = true;
            air.reportStatus(sw, 1);
            await waitForValue(rfd, CH0, 'CONFIG_PENDING', false, 30000);
            assert.equal(sw.list(1, 1).get(48), 5, 'TRANSMIT_TRY_MAX = list 1 index 48 on the device');
            const master = await rfd.call('getParamset', [CH1, 'MASTER']);
            assert.equal(master.TRANSMIT_TRY_MAX, 5);
        }).finally(cleanup);
    },
);

test(
    'duty cycle: the module reports it, rfd shows it; a send refused for duty cycle faults and marks the device unreachable',
    options(),
    async (t) => {
        const {rfd, receiver, air, sw, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            await pairSwitch(rfd, receiver, air, sw);
            rfd.module.sendDutyCycleEvent(80);
            await sleep(500);
            const interfaces = await rfd.call('listBidcosInterfaces');
            assert.equal(interfaces[0].DUTY_CYCLE, 80, JSON.stringify(interfaces[0]));
            assert.ok(rfd.grep(/Duty cycle event with value: 80/).length >= 1, 'rfd logged the value');

            const from = receiver.received.length;
            air.forceStatus(BIDCOS_STATUS.SEND_FAILED_DUTYCYCLE);
            const outcome = await faultOrResult(rfd.call('setValue', [CH1, 'STATE', true], {timeout: 30000}));
            t.diagnostic(`set under duty cycle: ${JSON.stringify(outcome).slice(0, 120)}`);
            assert.ok(outcome.fault, 'the set faults when the module refuses it for the duty cycle (measured)');
            await waitForEvent(receiver, CH0, 'UNREACH', true, {from});
            assert.equal(sw.behaviour.channel(1).STATE, 0, 'the telegram never reached the device');
        }).finally(cleanup);
    },
);

test('the same events on an XML-RPC receiver (http://): newDevices and STATE after a set', options(), async (t) => {
    const {rfd, receiver, air, sw, cleanup} = await setup(t, {protocol: 'xmlrpc'});
    await withDaemon(rfd, async () => {
        assert.ok(receiver.url.startsWith('http://'));
        await pairSwitch(rfd, receiver, air, sw);
        const from = receiver.received.length;
        await rfd.xmlrpc.call('setValue', [CH1, 'STATE', true]);
        await waitForEvent(receiver, CH1, 'STATE', true, {from});
        assert.deepEqual(eventValues(receiver, CH1, 'STATE', from), [true]);
        assert.equal(await rfd.xmlrpc.call('getValue', [CH1, 'STATE']), true);
    }).finally(cleanup);
});
