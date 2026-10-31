/**
 * rfd with two interfaces on one air: an RPI-RF-MOD on a pty (interface 0, `Type = CCU2`) and an HM-LGW in JavaScript
 * on another loopback address (interface 1, `Type = HMLGW2` with a LAN key) - the setup of anyone with an HM-LGW next
 * to the module. Both simulated modules share the air; each hears a device with its own RSSI.
 *
 * What rfd 3.89.11 does, from its source (BidcosInterfaceConcentrator.cpp): a frame arrives once per interface; the
 * first copy is processed, a later copy with a better RSSI re-arms a timer (ROAMING_CHECK_DELAY = 150 ms) after which
 * a device with roaming on is moved to that interface (CheckAndUpdateInterfaceAssociation: REMOVE_LINK_PEER on the
 * old module, ADD_LINK_PEER on the new), not within AFTER_SEND_ROAM_INHIBIT_TIME = 300 ms of a send to it. A new
 * device's SYSINFO is held back for those 150 ms, so it is paired through the interface that heard it best (roaming
 * off). setBidcosInterface(address, interface, roaming) moves it by hand. Copies from the other interface go into
 * rssiInfo. The duty cycle a module reports is sorted into bands (DUTYCYCLE_THRESHOLDMAP 0/40/65/80/90/95/98/99/100,
 * BidcosInterface::SetDutyCycle) and an event (interface, DUTY_CYCLE) is raised when the band changes - upwards when
 * the next bound is reached, downwards only at or below the bound below the current band.
 *
 * Timing assumptions (rfd 3.89.11): a sent telegram's status within defaultResponseTimeout = 4000 ms; the simulated
 * module acknowledges after ackDelayMs = 155 ms (measured) and reports a device out of its range as SEND_FAILED after
 * failDelayMs = 1106 ms (measured); after a failed send rfd refuses the next one for FAIL_COUNTER_RESET_TIME = 5000 ms;
 * the HM-LGW reconnect attempt comes every 5 s. Waits have margins of a second or more over the 150/300 ms windows.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {spawnRfd, withDaemon, skipWithoutDaemons, tmpdir} from '../helpers/daemon.js';
import {startReceiver} from '../helpers/rpc.js';
import {attachSwitch, pairDevice, SWITCH_SERIAL, SWITCH_ADDRESS} from '../helpers/switch.js';
import {regression} from '../helpers/known.js';
import {RadioModule} from '../../lib/module.js';
import {createPtyModule} from '../../lib/pty.js';
import {createLgwFront} from '../../lib/lgw.js';
import {Air} from '../../lib/air.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutDaemons, timeout: 240000, ...extra});
const SW1 = `${SWITCH_SERIAL}:1`;
const SERIAL_A = 'SIMMOD0001';
const SERIAL_B = 'SIMLGW0002';
const LAN_KEY = 'TestLanKey0123';

/** rfd with the pty module (A) and the LAN gateway (B) on one air, a receiver registered. */
async function setup(t) {
    const dir = tmpdir('hmrs-two');
    const a = new RadioModule({serial: SERIAL_A});
    const b = new RadioModule({serial: SERIAL_B});
    const pty = await createPtyModule({module: a, link: path.join(dir, 'uart0')});
    const front = await createLgwFront({module: b, serial: SERIAL_B, key: LAN_KEY, listen: '127.0.0.2'});
    const air = new Air({modules: [a, b]});
    const rfd = await spawnRfd({
        interfaces: [
            {type: 'CCU2', dev: pty.link},
            {type: 'HMLGW2', serial: SERIAL_B, ip: front.host, key: LAN_KEY},
        ],
    });
    rfd.module = a;
    rfd.air = air;
    rfd.lgw = front;
    rfd.pty = pty;
    await rfd.waitReady();
    const receiver = await startReceiver();
    await rfd.call('init', [receiver.url, 'hmrs']);
    await receiver.waitFor('newDevices', 15000);
    await waitConnected(rfd, [SERIAL_A, SERIAL_B]);
    const cleanup = async () => {
        t.diagnostic(`trace: ${air.traceLines().slice(-40).join(' > ')}`);
        await receiver.stop();
        b.close();
    };
    return {rfd, receiver, air, a, b, pty, front, cleanup};
}

async function waitConnected(rfd, serials, timeout = 30000) {
    const until = Date.now() + timeout;
    let list = [];
    while (Date.now() < until) {
        list = await rfd.call('listBidcosInterfaces');
        if (serials.every((s) => list.some((i) => i.ADDRESS === s && i.CONNECTED))) {
            return list;
        }
        await sleep(300);
    }
    throw new Error(`interfaces not connected: ${JSON.stringify(list)}`);
}

/** The link-peer commands a module got for an address: "+" for ADD_LINK_PEER, "-" for REMOVE_LINK_PEER. */
function peerLog(m, address) {
    return m.commands
        .filter(
            (c) =>
                (c.name === 'ADD_LINK_PEER' || c.name === 'REMOVE_LINK_PEER') &&
                c.data.length >= 3 &&
                c.data.readUIntBE(0, 3) === address,
        )
        .map((c) => (c.name === 'ADD_LINK_PEER' ? '+' : '-'))
        .join('');
}

/** Counts the SEND_TELEGRAMs to an address per module from now on. */
function countSends(modules, address) {
    const counts = new Map(modules.map((m) => [m, 0]));
    for (const m of modules) {
        m.on('telegram', (r) => {
            if (r.telegram.dst === address) {
                counts.set(m, counts.get(m) + 1);
            }
        });
    }
    return counts;
}

async function waitFor(predicate, timeout, what) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (predicate()) {
            return;
        }
        await sleep(50);
    }
    throw new Error(`timeout: ${what}`);
}

async function faultOrResult(promise) {
    return promise.then(
        (result) => (result && typeof result === 'object' && 'faultCode' in result ? {fault: result} : {result}),
        (error) => ({fault: error}),
    );
}

test(
    'two interfaces: both listed and connected, one default, setInterfaceClock reaches both modules',
    options(),
    async (t) => {
        const {rfd, a, b, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const list = await rfd.call('listBidcosInterfaces');
            t.diagnostic(JSON.stringify(list));
            assert.deepEqual(list.map((i) => i.ADDRESS).sort(), [SERIAL_B, SERIAL_A].sort());
            assert.equal(list.filter((i) => i.DEFAULT).length, 1);
            assert.ok(list.every((i) => typeof i.DUTY_CYCLE === 'number'));
            const utc = 1760000000;
            await rfd.call('setInterfaceClock', [utc, 120]);
            await sleep(500);
            for (const m of [a, b]) {
                assert.deepEqual(
                    m.clock,
                    {utcSeconds: utc, offsetHalfHours: 4},
                    `${m.serial}: 120 minutes = 4 half hours`,
                );
            }
        }).finally(cleanup);
    },
);

test(
    'a device is paired through the interface that hears it better; rssiInfo has both; setBidcosInterface moves it',
    options(),
    async (t) => {
        const {rfd, receiver, air, a, b, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const {device: sw} = attachSwitch(rfd);
            air.setRssi(sw, a, -80);
            air.setRssi(sw, b, -50);
            await pairDevice(rfd, receiver, air, sw);
            const desc = await rfd.call('getDeviceDescription', [SWITCH_SERIAL]);
            t.diagnostic(
                `after pairing: INTERFACE ${desc.INTERFACE}, ROAMING ${desc.ROAMING}; A ${peerLog(a, SWITCH_ADDRESS)}, B ${peerLog(b, SWITCH_ADDRESS)}`,
            );
            assert.equal(desc.INTERFACE, SERIAL_B, 'paired through B, the better one (not the default)');
            // measured: ROAMING is an integer (0/1) in the device description, not a boolean
            assert.equal(desc.ROAMING, 0, 'roaming off after pairing');
            assert.ok(b.peers.has(SWITCH_ADDRESS), 'B holds the device');
            assert.ok(!a.peers.has(SWITCH_ADDRESS), 'A does not');

            air.reportStatus(sw, 1);
            await sleep(1000);
            const info = await rfd.call('rssiInfo', []);
            t.diagnostic(`rssiInfo: ${JSON.stringify(info)}`);
            assert.deepEqual(info[SERIAL_A][SWITCH_SERIAL], [-80, 65536], 'A heard the device at -80');
            assert.deepEqual(info[SERIAL_B][SWITCH_SERIAL], [-50, 65536], 'B heard it at -50');
            assert.equal(info[SWITCH_SERIAL][SERIAL_B][1], -50);

            // by hand to A (roaming off): ADD on A, REMOVE on B, and the next set goes through A
            const sends = countSends([a, b], SWITCH_ADDRESS);
            await rfd.call('setBidcosInterface', [SWITCH_SERIAL, SERIAL_A, false]);
            await sleep(500);
            t.diagnostic(
                `after setBidcosInterface(A): A ${peerLog(a, SWITCH_ADDRESS)}, B ${peerLog(b, SWITCH_ADDRESS)}`,
            );
            assert.ok(a.peers.has(SWITCH_ADDRESS) && !b.peers.has(SWITCH_ADDRESS));
            assert.equal((await rfd.call('getDeviceDescription', [SWITCH_SERIAL])).INTERFACE, SERIAL_A);
            await rfd.call('setValue', [SW1, 'STATE', true]);
            assert.equal(sends.get(a), 1, 'the set went through A');
            assert.equal(sends.get(b), 0);
            assert.equal(sw.behaviour.channel(1).STATE, 200);

            // roaming off: a better copy on B does not move it
            air.reportStatus(sw, 1);
            await sleep(1500);
            assert.ok(a.peers.has(SWITCH_ADDRESS) && !b.peers.has(SWITCH_ADDRESS), 'no roaming when it is off');
        }).finally(cleanup);
    },
);

test(
    'roaming: a better copy on the other interface moves the device after 150 ms, not within 300 ms of a send',
    options(),
    async (t) => {
        const {rfd, receiver, air, a, b, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const {device: sw} = attachSwitch(rfd);
            air.setRssi(sw, a, -50);
            air.setRssi(sw, b, -80);
            await pairDevice(rfd, receiver, air, sw);
            assert.equal((await rfd.call('getDeviceDescription', [SWITCH_SERIAL])).INTERFACE, SERIAL_A);
            await rfd.call('setBidcosInterface', [SWITCH_SERIAL, SERIAL_A, true]);
            assert.equal((await rfd.call('getDeviceDescription', [SWITCH_SERIAL])).ROAMING, 1);
            await sleep(500);

            // the device moves: B hears it better now, and B's copy reaches rfd second (A's 30 ms earlier) - the
            // case of the 150 ms timer
            air.setRssi(sw, a, -85);
            air.setRssi(sw, b, -45);
            air.moduleGapMs = 30;
            const at = Date.now();
            air.reportStatus(sw, 1);
            await waitFor(() => b.peers.has(SWITCH_ADDRESS), 3000, 'ADD_LINK_PEER on B');
            const movedMs = Date.now() - at;
            t.diagnostic(
                `moved to B ${movedMs} ms after the status report; A ${peerLog(a, SWITCH_ADDRESS)}, B ${peerLog(b, SWITCH_ADDRESS)}`,
            );
            assert.ok(movedMs >= 100, `not before ROAMING_CHECK_DELAY (${movedMs} ms)`);
            assert.ok(!a.peers.has(SWITCH_ADDRESS), 'REMOVE_LINK_PEER on A');
            const sends = countSends([a, b], SWITCH_ADDRESS);
            await rfd.call('setValue', [SW1, 'STATE', true]);
            assert.deepEqual([sends.get(a), sends.get(b)], [0, 1], 'the next set goes through B');

            // right after a send the association is held (AFTER_SEND_ROAM_INHIBIT_TIME): A better again, a status
            // report at once - no move by the timer; the next send moves it
            air.setRssi(sw, a, -40);
            air.setRssi(sw, b, -90);
            const peersA = peerLog(a, SWITCH_ADDRESS);
            await rfd.call('setValue', [SW1, 'STATE', false]);
            air.reportStatus(sw, 1);
            await sleep(1000);
            const heldBack = peerLog(a, SWITCH_ADDRESS) === peersA;
            t.diagnostic(`status report right after a send: ${heldBack ? 'held back' : 'moved anyway'}`);
            assert.ok(heldBack, 'no move within 300 ms of a send');
            assert.ok(b.peers.has(SWITCH_ADDRESS));
            // the timer was spent inside the inhibit time: the next send moves it
            const sends2 = countSends([a, b], SWITCH_ADDRESS);
            await rfd.call('setValue', [SW1, 'STATE', true]);
            t.diagnostic(
                `next set: A ${sends2.get(a)}, B ${sends2.get(b)}; A ${peerLog(a, SWITCH_ADDRESS)}, B ${peerLog(b, SWITCH_ADDRESS)}`,
            );
            assert.equal(sends2.get(a), 1, 'the next send went through A');
            assert.ok(a.peers.has(SWITCH_ADDRESS));

            // the better copy (B) reaches rfd first: no timer (the worse copy that follows does not re-arm it) - the
            // device moves with the next send, not before
            await sleep(500);
            air.setRssi(sw, a, -90);
            air.setRssi(sw, b, -40);
            air.receiveOrder = [b, a];
            const peersB = peerLog(b, SWITCH_ADDRESS);
            air.reportStatus(sw, 1);
            await sleep(1000);
            t.diagnostic(
                `better copy first: ${peerLog(b, SWITCH_ADDRESS) === peersB ? 'not moved by itself' : 'moved by itself'}`,
            );
            assert.equal(peerLog(b, SWITCH_ADDRESS), peersB, 'not moved without a send');
            const sends3 = countSends([a, b], SWITCH_ADDRESS);
            await rfd.call('setValue', [SW1, 'STATE', false]);
            assert.deepEqual([sends3.get(a), sends3.get(b)], [0, 1], 'moved to B at the send');
        }).finally(cleanup);
    },
);

test(
    '#272 (#174): setBidcosInterface with an interface that does not exist is refused; the id is compared exactly',
    options(regression(272)),
    async (t) => {
        const {rfd, receiver, air, a, b, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const {device: sw} = attachSwitch(rfd);
            air.setRssi(sw, a, -50);
            air.setRssi(sw, b, -80);
            await pairDevice(rfd, receiver, air, sw);
            const before = (await rfd.call('getDeviceDescription', [SWITCH_SERIAL])).INTERFACE;
            const bogus = await faultOrResult(rfd.call('setBidcosInterface', [SWITCH_SERIAL, 'NOSUCHIFACE', false]));
            const after = (await rfd.call('getDeviceDescription', [SWITCH_SERIAL])).INTERFACE;
            const defaultIface = (await rfd.call('listBidcosInterfaces')).find((i) => i.DEFAULT).ADDRESS;
            t.diagnostic(
                `setBidcosInterface(NOSUCHIFACE): ${JSON.stringify(bogus)}; INTERFACE ${before} -> ${after}; default ${defaultIface}`,
            );
            // measured on 3.89.11: an empty result, INTERFACE = NOSUCHIFACE, the device on the default interface
            assert.ok((defaultIface === SERIAL_A ? a : b).peers.has(SWITCH_ADDRESS), 'the device is on an interface');
            assert.ok(bogus.fault, 'an unknown interface is a fault');
            assert.equal(after, before, 'the interface is unchanged');
            // the check is an exact lookup in the map of interfaces: another spelling of a real serial is unknown too
            const lower = await faultOrResult(
                rfd.call('setBidcosInterface', [SWITCH_SERIAL, SERIAL_B.toLowerCase(), false]),
            );
            assert.ok(lower.fault, `a serial in another case is refused: ${JSON.stringify(lower)}`);
            // an empty id still selects the default interface, and a real serial still moves the device
            const empty = await faultOrResult(rfd.call('setBidcosInterface', [SWITCH_SERIAL, '', false]));
            assert.equal(empty.fault, undefined, JSON.stringify(empty));
            const real = await faultOrResult(rfd.call('setBidcosInterface', [SWITCH_SERIAL, SERIAL_B, false]));
            assert.equal(real.fault, undefined, JSON.stringify(real));
            assert.equal((await rfd.call('getDeviceDescription', [SWITCH_SERIAL])).INTERFACE, SERIAL_B);
        }).finally(cleanup);
    },
);

test('one interface lost: devices on the other carry on, a roaming device is taken over', options(), async (t) => {
    const {rfd, receiver, air, a, b, front, cleanup} = await setup(t);
    await withDaemon(rfd, async () => {
        // the switch on B (the LAN gateway) with roaming, a second one on A without
        const {device: sw} = attachSwitch(rfd);
        air.setRssi(sw, a, -70);
        air.setRssi(sw, b, -50);
        await pairDevice(rfd, receiver, air, sw);
        await rfd.call('setBidcosInterface', [SWITCH_SERIAL, SERIAL_B, true]);
        const {device: other} = attachSwitch(rfd, {address: 0x13579b, serial: 'SIM0000777'});
        air.setRssi(other, a, -50);
        air.setRssi(other, b, null);
        await pairDevice(rfd, receiver, air, other);
        await sleep(300);

        // the gateway is gone (rfd's 3.89.11 pty interface would keep CONNECTED after a hangup, #116 - so B goes)
        await front.lose();
        air.setRssi(sw, b, null);
        let list = [];
        const until = Date.now() + 20000;
        while (Date.now() < until) {
            list = await rfd.call('listBidcosInterfaces');
            if (list.find((i) => i.ADDRESS === SERIAL_B)?.CONNECTED === false) {
                break;
            }
            await sleep(300);
        }
        t.diagnostic(`after losing B: ${JSON.stringify(list.map((i) => [i.ADDRESS, i.CONNECTED, i.DEFAULT]))}`);
        assert.equal(list.find((i) => i.ADDRESS === SERIAL_B).CONNECTED, false);
        assert.equal(list.find((i) => i.ADDRESS === SERIAL_A).CONNECTED, true);

        // the device on A carries on
        await rfd.call('setValue', ['SIM0000777:1', 'STATE', true], {timeout: 30000});
        assert.equal(other.behaviour.channel(1).STATE, 200, 'A still sends');

        const started = Date.now();
        const lost = await faultOrResult(rfd.call('setValue', [SW1, 'STATE', true], {timeout: 30000}));
        t.diagnostic(
            `set through the lost interface: ${JSON.stringify(lost).slice(0, 120)} after ${Date.now() - started} ms`,
        );
        assert.ok(lost.fault, 'a send through the lost interface fails');
        assert.equal(sw.behaviour.channel(1).STATE, 0);

        // the device speaks; only A hears it - roaming takes it over with the next send
        await sleep(5500); // FAIL_COUNTER_RESET_TIME
        air.reportStatus(sw, 1);
        await sleep(500);
        await rfd.call('setValue', [SW1, 'STATE', true], {timeout: 30000});
        t.diagnostic(`A ${peerLog(a, SWITCH_ADDRESS)}, B ${peerLog(b, SWITCH_ADDRESS)}`);
        assert.ok(a.peers.has(SWITCH_ADDRESS), 'the device is on A now');
        assert.equal(sw.behaviour.channel(1).STATE, 200, 'set through A');
        await front.reappear();
    }).finally(cleanup);
});

test(
    'duty-cycle bands: an event when a band changes, none inside a band, per interface; downwards with hysteresis',
    options(),
    async (t) => {
        const {rfd, receiver, a, b, cleanup} = await setup(t);
        await withDaemon(rfd, async () => {
            const from = receiver.received.length;
            // 100 % is left out: it reads past rfd's threshold map (finding dutycycle-upper-bound, rfd-load.test.js)
            const steps = [10, 39, 41, 50, 64, 66, 79, 81, 89, 91, 94, 96, 97, 98, 99, 60, 30, 0];
            for (const percent of steps) {
                b.sendDutyCycleEvent(percent);
                await sleep(150);
            }
            await sleep(1000);
            const events = (address) =>
                receiver.received
                    .slice(from)
                    .filter((r) => r.method === 'event' && r.params[1] === address && r.params[2] === 'DUTY_CYCLE')
                    .map((r) => r.params[3]);
            t.diagnostic(`DUTY_CYCLE events of B: ${events(SERIAL_B).join(', ')}`);
            assert.deepEqual(events(SERIAL_B), [41, 66, 81, 91, 96, 98, 99, 60, 30, 0]);
            assert.deepEqual(events(SERIAL_A), [], 'nothing for A');
            const list = await rfd.call('listBidcosInterfaces');
            assert.equal(list.find((i) => i.ADDRESS === SERIAL_B).DUTY_CYCLE, 0);
            a.sendDutyCycleEvent(70);
            await sleep(500);
            assert.equal((await rfd.call('listBidcosInterfaces')).find((i) => i.ADDRESS === SERIAL_A).DUTY_CYCLE, 70);
            assert.deepEqual(events(SERIAL_A), [70], 'A: from band 0 straight to band 2');
        }).finally(cleanup);
    },
);
