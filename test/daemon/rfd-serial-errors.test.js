/**
 * rfd's serial device failing the way real ones fail - OpenCCU-Base #115 (do not crash on read errors) and #116
 * (report a device with a persistent read error as not connected). A stale /dev/mmd_bidcos after a multimacd restart
 * answers read() with ENODEV, an unplugged USB adapter with EIO; a pty whose master went away answers 0 instead
 * (rfd-pty-module.test.js, the read-eof finding), which never reaches the fixed code. So these tests load the fault
 * shim (shim/hmrs-faults.c, LD_PRELOAD): read() and select() on the module's pty fail with the errno the test names,
 * select() reports the failing device readable as the kernel does. No rfd code is changed.
 *
 * What the fixes do (main, CCU2SerialPortWrapperLinux.cpp): read()'s result is a ssize_t (3.89.11 kept it in an
 * unsigned int, so -1 became 4294967295 and append() copied 4 GiB out of a 256-byte buffer); handleReadError() logs
 * one "<call>() failed" line per error streak, sleeps 1 s against spinning, ignores EINTR; IsConnected() is false
 * while the streak lasts and true again after the next successful read.
 *
 * Timing assumptions (rfd main): handleReadError sleeps 1000 ms per failed read; rfd asks the module for its duty cycle
 * every ~26 s (measured); the clock-tick budget is 100 of 200 ticks in 2 s (USER_HZ 100). Waits of 3 s and more.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {startRfd, skipWithoutFaultShim} from '../helpers/daemon.js';
import {regression} from '../helpers/known.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (extra = {}) => ({...skipWithoutFaultShim, timeout: 120000, ...extra});

async function connected(rfd) {
    return (await rfd.call('listBidcosInterfaces', [], {timeout: 5000}))[0].CONNECTED;
}

/** Polls `predicate` every 200 ms; true when it held within `ms`. */
async function waitFor(predicate, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (await predicate().catch(() => false)) {
            return true;
        }
        await sleep(200);
    }
    return false;
}

async function ticksIn(rfd, ms) {
    const before = rfd.cpuTicks();
    await sleep(ms);
    return rfd.cpuTicks() - before;
}

const errorLines = (rfd, call) => rfd.grep(new RegExp(`${call}\\(\\) failed`));

test(
    'a persistent ENODEV on the serial device: rfd lives, logs once, does not spin, reports CONNECTED false',
    options(),
    async (t) => {
        const rfd = await startRfd({faults: true});
        try {
            assert.equal(await connected(rfd), true);
            rfd.setFault('fail ENODEV');
            await sleep(3500);
            t.diagnostic(
                `injected: ${rfd.faultLog().length} failures; rfd ${rfd.alive ? 'alive' : JSON.stringify(rfd.exit)}`,
            );
            await t.test('rfd survives the failing read()', regression(115), () => {
                assert.ok(rfd.faultLog().length >= 1, 'the shim made read() fail');
                assert.ok(rfd.alive, `rfd exited: ${JSON.stringify(rfd.exit)}\n${rfd.tail(15)}`);
            });
            if (!rfd.alive) {
                return;
            }
            const ticks = await ticksIn(rfd, 2000);
            t.diagnostic(`${ticks} clock ticks in 2 s; error lines: ${errorLines(rfd, 'read').length}`);
            await t.test('one error line for the whole streak, no busy loop', regression(115), () => {
                assert.equal(errorLines(rfd, 'read').length, 1, rfd.grep(/failed/).join('\n'));
                assert.ok(ticks < 100, `${ticks} clock ticks (of 200) in 2 s`);
            });
            await t.test(
                'listBidcosInterfaces reports CONNECTED false, RPC keeps answering',
                regression(116),
                async () => {
                    assert.equal(await connected(rfd), false);
                },
            );
        } finally {
            await rfd.stop();
        }
    },
);

test(
    'EIO for a while, then the module answers again: CONNECTED goes false and back to true, events arrive',
    options(),
    async (t) => {
        const rfd = await startRfd({faults: true});
        try {
            assert.equal(await connected(rfd), true);
            // an unplugged adapter: read() fails with EIO until it is back; rfd sleeps 1 s per failed read, so the
            // error streak is long enough to be seen through RPC
            rfd.setFault('fail EIO');
            const during = await waitFor(async () => (await connected(rfd)) === false, 6000);
            await t.test('rfd survives', regression(115), () => {
                assert.ok(rfd.alive, `rfd exited: ${JSON.stringify(rfd.exit)}\n${rfd.tail(15)}`);
            });
            if (!rfd.alive) {
                return;
            }
            // the adapter is back and the module speaks: the next successful read() ends the streak
            rfd.setFault('clear');
            await sleep(1500);
            rfd.module.sendDutyCycleEvent(7);
            const after = await waitFor(async () => (await connected(rfd)) === true, 6000);
            t.diagnostic(
                `CONNECTED false during the EIO streak: ${during}, true after the module spoke: ${after}; ${rfd.faultLog().length} failures injected`,
            );
            await t.test('CONNECTED false during the streak, true after the next good read', regression(116), () => {
                assert.ok(during, 'CONNECTED stayed true during the EIO streak');
                assert.ok(after, 'CONNECTED did not come back after a successful read');
            });
            const event = await waitFor(async () => rfd.grep(/Duty cycle event/i).length >= 1, 5000);
            assert.ok(event, 'the module event after the error reached rfd');
        } finally {
            await rfd.stop();
        }
    },
);

test('EINTR on read(): no error line, CONNECTED stays true', options(), async (t) => {
    const rfd = await startRfd({faults: true});
    try {
        rfd.setFault('eintr-once');
        rfd.module.sendDutyCycleEvent(3); // something to read, so the interrupted read() is followed by a good one
        await sleep(2000);
        t.diagnostic(`${rfd.faultLog().join(', ')}; rfd ${rfd.alive ? 'alive' : JSON.stringify(rfd.exit)}`);
        await t.test('EINTR is not an error', regression(115), async () => {
            assert.ok(rfd.alive, `rfd exited: ${JSON.stringify(rfd.exit)}`);
            assert.equal(errorLines(rfd, 'read').length, 0);
            assert.equal(await connected(rfd), true);
        });
    } finally {
        await rfd.stop();
    }
});

test('a failing select(): handled like a failing read() - alive, one line, no spin', options(), async (t) => {
    const rfd = await startRfd({faults: true});
    try {
        rfd.setFault('select-fail EBADF');
        await sleep(3000);
        t.diagnostic(`injected ${rfd.faultLog().length}; rfd ${rfd.alive ? 'alive' : JSON.stringify(rfd.exit)}`);
        await t.test('alive, one select() line, no busy loop', regression(115), async () => {
            assert.ok(rfd.alive, `rfd exited: ${JSON.stringify(rfd.exit)}`);
            const ticks = await ticksIn(rfd, 2000);
            t.diagnostic(`${ticks} clock ticks in 2 s; select lines ${errorLines(rfd, 'select').length}`);
            assert.equal(errorLines(rfd, 'select').length, 1, rfd.grep(/failed/).join('\n'));
            assert.ok(ticks < 100, `${ticks} clock ticks (of 200) in 2 s`);
        });
    } finally {
        await rfd.stop();
    }
});
