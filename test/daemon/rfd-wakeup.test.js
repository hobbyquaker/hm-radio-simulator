/**
 * Devices that sleep: a wake-up device (HM-PB-2-WM55, rx_modes CONFIG,WAKEUP), a lazy-config one (HM-RC-4-2,
 * CONFIG,WAKEUP,LAZY_CONFIG) and a burst device (HM-LC-Sw1-Ba-PCB, BURST), from the image's rftypes.
 *
 * What rfd 3.89.11 does with them, from its source: for a device whose RxNeedsWakeup() is true, a setValue or a
 * getValue that needs the air is queued (RFDevice::QueueAfterWakeupFrame, 10 deep, the oldest dropped with a
 * warning) and a MASTER write only marks the configuration pending; in both cases rfd asks the module to wake the
 * device (AddDeviceWakeupRequest: ADD_LINK_PEER again, with the wake-up byte, and the lazy-config byte for
 * RX_LAZY_CONFIG). When an event of the device carries the module's WOKEN_UP flag, rfd sends the queue
 * (SendAfterWakeupFrames), commits the configuration (CommitPendingConfig) and, when nothing is left, clears the
 * request. A deferred delete (deleteDevice flag 0x04) of a device that cannot be reached waits for that moment too
 * (ScheduleDelete; abortDeleteDevice cancels it). A burst device gets CTRL_BURST unless rfd reached it within the last
 * BURST_ACTIVE_INTERVAL = 1800 ms; a non-burst send gets a second try as a burst.
 *
 * Timing assumptions (rfd 3.89.11): a sent telegram's status within defaultResponseTimeout = 4000 ms (12000 ms for a
 * triple burst); the simulated module answers after ackDelayMs = 155 ms (measured), plus the computed 360 ms burst
 * preamble, and reports a device that does not hear the telegram as SEND_FAILED after failDelayMs = 3000 ms (chosen);
 * after a failed send rfd refuses the next one for FAIL_COUNTER_RESET_TIME = 5000 ms. The sleeping device's windows
 * (300 ms after its own telegram, 1000 ms after a wake-up, 2000 ms after a burst, 15 s config mode) are chosen
 * (lib/device.js). Waits have margins of seconds.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {startRfd, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {startReceiver} from '../helpers/rpc.js';
import {
    attachWakeupButton,
    attachLazyRemote,
    attachBurstSwitch,
    attachMotionDetector,
    pairDevice,
    waitForEvent,
    waitForValue,
    BUTTON_SERIAL,
    BUTTON_ADDRESS,
    LAZY_SERIAL,
    LAZY_ADDRESS,
    MOTION_SERIAL,
    MOTION_ADDRESS,
    BURST_SERIAL,
    BURST_ADDRESS,
} from '../helpers/switch.js';
import {decodeTelegram, CTRL, FT} from '../../lib/telegram.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 240000, ...extra});
const BTN0 = `${BUTTON_SERIAL}:0`;
const BTN1 = `${BUTTON_SERIAL}:1`;
const BA0 = `${BURST_SERIAL}:0`;
const BA1 = `${BURST_SERIAL}:1`;
const DELETE_FLAG_DEFER = 0x04;

async function setup(t) {
    const rfd = await startRfd();
    const receiver = await startReceiver();
    await rfd.call('init', [receiver.url, 'hmrs']);
    await receiver.waitFor('newDevices', 15000);
    const cleanup = async () => {
        if (rfd.air) {
            t.diagnostic(`trace: ${rfd.air.traceLines().slice(-60).join(' > ')}`);
        }
        await receiver.stop();
    };
    return {rfd, receiver, cleanup};
}

/** The wake-up and lazy-config bytes of every ADD_LINK_PEER the module got for an address, in order. */
function wakeupFlags(rfd, address) {
    return rfd.module.commands
        .filter((c) => c.name === 'ADD_LINK_PEER' && c.data.length >= 3 && c.data.readUIntBE(0, 3) === address)
        .map((c) => `${c.data[4] ?? '-'}/${c.data[5] ?? '-'}`);
}

/** Waits until the module holds (or no longer holds) a wake-up request for the address. */
async function waitForWakeupRequest(rfd, address, wanted, timeout = 10000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (Boolean(rfd.module.wakeupRequest(address)) === wanted) {
            return;
        }
        await sleep(100);
    }
    throw new Error(
        `wake-up request for ${address.toString(16)} not ${wanted ? 'set' : 'cleared'}: ${wakeupFlags(rfd, address)}`,
    );
}

/** The telegrams the daemon sent to an address, decoded, from trace index `from`. */
function sentTo(air, address, from = 0) {
    return air.trace
        .slice(from)
        .filter((e) => e.dir === 'tx' && e.hex.length >= 20)
        .map((e) => ({...e, t: decodeTelegram(Buffer.from(e.hex, 'hex'))}))
        .filter((e) => e.t && e.t.dst === address && e.t.type !== FT.WAKEUP);
}

async function faultOrResult(promise) {
    return promise.then(
        (result) => (result && typeof result === 'object' && 'faultCode' in result ? {fault: result} : {result}),
        (error) => ({fault: error}),
    );
}

test(
    'a wake-up device: a MASTER write stays pending, rfd asks the module to wake the device, the WOKEN_UP event delivers it',
    options(),
    async (t) => {
        const {rfd, receiver, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const {air, device: btn} = attachWakeupButton(rfd);
            const {newDevices} = await pairDevice(rfd, receiver, air, btn);
            assert.equal(newDevices.params[1].find((d) => d.ADDRESS === BUTTON_SERIAL).TYPE, 'HM-PB-2-WM55');
            await waitForWakeupRequest(rfd, BUTTON_ADDRESS, false);
            t.diagnostic(`ADD_LINK_PEER wake-up/lazy bytes after pairing: ${wakeupFlags(rfd, BUTTON_ADDRESS)}`);
            btn.sleep();

            const from = air.trace.length;
            const fromEvents = receiver.received.length;
            const started = Date.now();
            await rfd.call('putParamset', [BTN1, 'MASTER', {LONG_PRESS_TIME: {explicitDouble: 1.0}}], {timeout: 30000});
            const took = Date.now() - started;
            t.diagnostic(`putParamset to the sleeping device returned after ${took} ms`);
            await waitForEvent(receiver, BTN0, 'CONFIG_PENDING', true, {from: fromEvents});
            await waitForWakeupRequest(rfd, BUTTON_ADDRESS, true);
            const flags = wakeupFlags(rfd, BUTTON_ADDRESS);
            t.diagnostic(`ADD_LINK_PEER wake-up/lazy bytes after the write: ${flags}`);
            assert.equal(flags.at(-1), '1/0', 'wake-up requested, no lazy config');
            // measured: rfd tries the write once at once (CONFIG_START, which the sleeping device does not hear: the
            // module's SEND_FAILED after failDelayMs), and only then marks it pending and asks for the wake-up
            assert.deepEqual(
                sentTo(air, BUTTON_ADDRESS, from).map((e) => e.name),
                ['CONFIG_START [bidi]'],
                'one try, then nothing more until the wake-up',
            );

            // the device's next telegram: the module wakes it, rfd delivers the configuration
            const at = Date.now();
            air.press(btn, 1);
            await waitForEvent(receiver, BTN1, 'PRESS_SHORT', true, {from: fromEvents});
            await waitForValue(rfd, BTN0, 'CONFIG_PENDING', false, 15000);
            t.diagnostic(`configuration delivered ${Date.now() - at} ms after the key press`);
            assert.equal(air.wakeups.filter((w) => w.address === BUTTON_ADDRESS).length >= 1, true);
            assert.ok(
                sentTo(air, BUTTON_ADDRESS, from).some((e) => e.name.startsWith('CONFIG_WRITE_INDEX')),
                'the write went out after the wake-up',
            );
            assert.equal((btn.list(1, 1).get(4) || 0) >> 4, 7, 'LONG_PRESS_TIME written into the device');
            await waitForWakeupRequest(rfd, BUTTON_ADDRESS, false);
            t.diagnostic(`ADD_LINK_PEER wake-up/lazy bytes at the end: ${wakeupFlags(rfd, BUTTON_ADDRESS)}`);
        }).finally(cleanup);
    },
);

test(
    'the wake-up queue: a command to a sleeping device is queued, ten deep with the oldest dropped, and sent after WOKEN_UP',
    options(),
    async (t) => {
        const {rfd, receiver, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const {air, device: md} = attachMotionDetector(rfd);
            await pairDevice(rfd, receiver, air, md);
            await waitForWakeupRequest(rfd, MOTION_ADDRESS, false);
            md.sleep();
            const from = air.trace.length;
            const commands = [];
            md.on('command', (m) => commands.push(m.frame.id));

            // twelve commands (ENTER_BOOTLOADER, the one to_device command the type has): the queue keeps ten
            const results = [];
            const started = Date.now();
            for (let i = 0; i < 12; i++) {
                results.push(
                    await faultOrResult(rfd.call('setValue', [`${MOTION_SERIAL}:0`, 'ENTER_BOOTLOADER', true])),
                );
            }
            t.diagnostic(
                `12 setValue in ${Date.now() - started} ms: ${JSON.stringify(results.map((r) => r.result ?? 'fault'))}`,
            );
            assert.ok(
                results.every((r) => !r.fault),
                'a queued command is not a fault',
            );
            assert.equal(sentTo(air, MOTION_ADDRESS, from).length, 0, 'nothing went out while the device sleeps');
            await waitForWakeupRequest(rfd, MOTION_ADDRESS, true);
            const warnings = rfd.grep(/Queue size exceeded, dropped oldest frame/).length;
            t.diagnostic(`rfd warned ${warnings} times about the queue`);
            assert.equal(warnings, 2, 'two of twelve frames dropped');

            air.reportStatus(md, 1);
            const until = Date.now() + 15000;
            while (commands.length < 10 && Date.now() < until) {
                await sleep(100);
            }
            await sleep(1500);
            t.diagnostic(`after the wake-up: ${commands.length} commands reached the device: ${commands.join(',')}`);
            assert.equal(commands.length, 10, 'the ten queued frames went out, no more');
            assert.ok(commands.every((c) => c === 'ENTER_BOOTLOADER'));
            await waitForWakeupRequest(rfd, MOTION_ADDRESS, false);
        }).finally(cleanup);
    },
);

test(
    'a lazy-config device: the wake-up request carries the lazy-config flag, the configuration arrives after its next telegram',
    options(),
    async (t) => {
        const {rfd, receiver, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const {air, device: rc} = attachLazyRemote(rfd);
            await pairDevice(rfd, receiver, air, rc);
            await waitForWakeupRequest(rfd, LAZY_ADDRESS, false);
            rc.sleep();
            await rfd.call('putParamset', [`${LAZY_SERIAL}:1`, 'MASTER', {LONG_PRESS_TIME: {explicitDouble: 1.0}}], {
                timeout: 30000,
            });
            await waitForWakeupRequest(rfd, LAZY_ADDRESS, true);
            const flags = wakeupFlags(rfd, LAZY_ADDRESS);
            t.diagnostic(`ADD_LINK_PEER wake-up/lazy bytes: ${flags}`);
            assert.equal(flags.at(-1), '1/1', 'wake-up and lazy config requested');
            assert.deepEqual(rfd.module.wakeupRequest(LAZY_ADDRESS), {lazy: true});
            air.press(rc, 2);
            await waitForValue(rfd, `${LAZY_SERIAL}:0`, 'CONFIG_PENDING', false, 15000);
            assert.ok(air.traceLines().includes('tx WAKEUP (lazy config)'));
            assert.equal((rc.list(1, 1).get(4) || 0) >> 4, 7);
            await waitForWakeupRequest(rfd, LAZY_ADDRESS, false);
        }).finally(cleanup);
    },
);

test(
    'deferred delete: deleteDevice with DEFER on a sleeping device waits for its wake-up; abortDeleteDevice cancels it',
    options(),
    async (t) => {
        const {rfd, receiver, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const {air, device: btn} = attachWakeupButton(rfd);
            await pairDevice(rfd, receiver, air, btn);
            await waitForWakeupRequest(rfd, BUTTON_ADDRESS, false);
            const listed = async () => (await rfd.call('listDevices', [])).some((d) => d.ADDRESS === BUTTON_SERIAL);

            // abort first: the deferred delete is scheduled, then cancelled - the next wake-up deletes nothing
            btn.sleep();
            let started = Date.now();
            const deferred = await faultOrResult(
                rfd.call('deleteDevice', [BUTTON_SERIAL, DELETE_FLAG_DEFER], {timeout: 60000}),
            );
            t.diagnostic(
                `deleteDevice(DEFER) on the sleeping device: ${JSON.stringify(deferred)} after ${Date.now() - started} ms`,
            );
            assert.ok(!deferred.fault, 'a deferred delete is not a fault');
            assert.equal(await listed(), true, 'the device is still there');
            await waitForWakeupRequest(rfd, BUTTON_ADDRESS, true);
            const aborted = await faultOrResult(rfd.call('abortDeleteDevice', [BUTTON_SERIAL]));
            t.diagnostic(`abortDeleteDevice: ${JSON.stringify(aborted)}`);
            assert.ok(!aborted.fault);
            const from = receiver.received.length;
            await sleep(5500); // FAIL_COUNTER_RESET_TIME
            air.press(btn, 1);
            await waitForEvent(receiver, BTN1, 'PRESS_SHORT', true, {from});
            await sleep(3000);
            assert.equal(await listed(), true, 'the aborted delete did not happen');
            assert.equal(receiver.calls('deleteDevices').length, 0);
            t.diagnostic(`wake-up/lazy bytes after the abort: ${wakeupFlags(rfd, BUTTON_ADDRESS)}`);

            // now for real: the wake-up deletes the device (rfd unpeers the central first, then reports it)
            btn.sleep();
            await sleep(5500);
            started = Date.now();
            assert.ok(
                !(await faultOrResult(rfd.call('deleteDevice', [BUTTON_SERIAL, DELETE_FLAG_DEFER], {timeout: 60000})))
                    .fault,
            );
            t.diagnostic(`second deleteDevice(DEFER): ${Date.now() - started} ms`);
            assert.equal(await listed(), true);
            await sleep(5500);
            const fromTrace = air.trace.length;
            air.press(btn, 2);
            const until = Date.now() + 20000;
            while (Date.now() < until && (await listed())) {
                await sleep(250);
            }
            assert.equal(await listed(), false, 'deleted at its wake-up');
            await receiver.waitFor('deleteDevices', 10000);
            t.diagnostic(
                `after the wake-up: ${sentTo(air, BUTTON_ADDRESS, fromTrace)
                    .map((e) => e.name)
                    .join(' | ')}`,
            );
            assert.equal(btn.pairedCentral(), 0, 'the device forgot the central (list 0 index 10..12 cleared)');
        }).finally(cleanup);
    },
);

test(
    'a burst device: the first send is a burst, the next within 1.8 s is not, a missed one is retried as a burst',
    options(),
    async (t) => {
        const {rfd, receiver, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const {air, device: ba} = attachBurstSwitch(rfd);
            const sent = [];
            rfd.module.on('telegram', (r) => {
                if (r.telegram.dst === BURST_ADDRESS) {
                    sent.push({at: Date.now(), burst: r.burst, ctrl: r.telegram.ctrl, type: r.telegram.type});
                }
            });
            await pairDevice(rfd, receiver, air, ba);
            const fromPairing = sent.length;
            t.diagnostic(
                `pairing: ${fromPairing} telegrams, ${sent.filter((s) => s.ctrl & CTRL.BURST).length} with the burst flag`,
            );
            ba.sleep();
            await sleep(2500); // past rfd's BURST_ACTIVE_INTERVAL

            let from = sent.length;
            let started = Date.now();
            await rfd.call('setValue', [BA1, 'STATE', true], {timeout: 30000});
            const firstMs = Date.now() - started;
            const first = sent.slice(from);
            t.diagnostic(`first set: ${JSON.stringify(first.map((s) => [s.burst, s.ctrl]))} in ${firstMs} ms`);
            assert.equal(first.length, 1);
            assert.ok(first[0].ctrl & CTRL.BURST, 'CTRL_BURST on the first send');
            assert.equal(first[0].burst, 1, 'the module is asked for a single burst');
            assert.equal(ba.behaviour.channel(1).STATE, 200);

            // within BURST_ACTIVE_INTERVAL: no burst (the device is still awake)
            from = sent.length;
            await rfd.call('setValue', [BA1, 'STATE', false], {timeout: 30000});
            const second = sent.slice(from);
            t.diagnostic(`second set: ${JSON.stringify(second.map((s) => [s.burst, s.ctrl]))}`);
            assert.equal(second.length, 1);
            assert.equal(second[0].ctrl & CTRL.BURST, 0, 'no burst within 1.8 s of the last one');
            assert.equal(ba.behaviour.channel(1).STATE, 0);

            // within the interval but the device already asleep: the plain send fails, the retry is a burst
            await sleep(300);
            ba.sleep();
            from = sent.length;
            started = Date.now();
            await rfd.call('setValue', [BA1, 'STATE', true], {timeout: 30000});
            const third = sent.slice(from);
            t.diagnostic(
                `third set: ${JSON.stringify(third.map((s) => [s.burst, s.ctrl]))} in ${Date.now() - started} ms`,
            );
            assert.equal(third.length, 2, 'two tries');
            assert.equal(third[0].ctrl & CTRL.BURST, 0);
            assert.ok(third[1].ctrl & CTRL.BURST, 'the second try is a burst');
            assert.equal(ba.behaviour.channel(1).STATE, 200);
            assert.equal(await rfd.call('getValue', [BA0, 'UNREACH']), false);

            // a burst device that does not answer at all: UNREACH (RxNeedsBurst counts like RxAlways)
            ba.answering = false;
            await sleep(2500);
            const fromEvents = receiver.received.length;
            const outcome = await faultOrResult(rfd.call('setValue', [BA1, 'STATE', false], {timeout: 30000}));
            t.diagnostic(`set to the silent burst device: ${JSON.stringify(outcome).slice(0, 100)}`);
            await waitForEvent(receiver, BA0, 'UNREACH', true, {from: fromEvents});
        }).finally(cleanup);
    },
);
