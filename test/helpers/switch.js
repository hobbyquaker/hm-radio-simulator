/**
 * A simulated switch (HM-LC-Sw1-Pl, rf_s.xml from the image's rftypes) on the air of a running rfd, and the pairing
 * through rfd's install mode as a logic layer would do it: setInstallMode, the device announces itself, rfd writes
 * the device's list 0, exchanges the AES key, reads the lists back and reports newDevices to the receiver.
 */

import path from 'node:path';

import {loadDeviceDescription} from '../../lib/rftypes.js';
import {BidcosDevice} from '../../lib/device.js';
import {Air} from '../../lib/air.js';
import {RFTYPES} from './daemon.js';

export const SWITCH_SERIAL = 'SIM0000123';
export const SWITCH_ADDRESS = 0x123456;
export const SWITCH_TYPE = 'HM-LC-Sw1-Pl';

let description = null;

export function switchDescription() {
    if (!description) {
        description = loadDeviceDescription(path.join(RFTYPES, 'rf_s.xml'));
    }
    return description;
}

/**
 * Puts an air with one switch behind the daemon's module.
 * @param {import('./daemon.js').Daemon} rfd
 * @param {object} [options] BidcosDevice options
 * @returns {{air: Air, device: BidcosDevice}}
 */
export function attachSwitch(rfd, options = {}) {
    const air = new Air({module: rfd.module});
    const device = air.add(
        new BidcosDevice({
            address: SWITCH_ADDRESS,
            serial: SWITCH_SERIAL,
            description: switchDescription(),
            typeId: SWITCH_TYPE,
            ...options,
        }),
    );
    rfd.air = air;
    return {air, device};
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pairs the switch: install mode on, the announcement, newDevices at the receiver, and the configuration finished
 * (CONFIG_PENDING false on channel 0).
 * @param {import('./daemon.js').Daemon} rfd
 * @param {import('./rpc.js').Receiver} receiver registered with init() before
 * @param {Air} air
 * @param {BidcosDevice} device
 * @param {{timeout?: number}} [options]
 * @returns {Promise<{newDevices: object}>}
 */
export async function pairSwitch(rfd, receiver, air, device, {timeout = 30000} = {}) {
    await rfd.call('setInstallMode', [true]);
    air.announce(device);
    const until = Date.now() + timeout;
    let newDevices = null;
    while (Date.now() < until) {
        newDevices = receiver
            .calls('newDevices')
            .find((c) => Array.isArray(c.params[1]) && c.params[1].some((d) => d.ADDRESS === SWITCH_SERIAL));
        if (newDevices) {
            break;
        }
        await sleep(200);
    }
    if (!newDevices) {
        throw new Error(
            `newDevices for ${SWITCH_SERIAL} did not arrive within ${timeout} ms; receiver got ${receiver.received.map((r) => r.method).join(' ')}; air: ${air.traceLines().join(' | ')}`,
        );
    }
    // the configuration after pairing (list reads, the enforced parameters) ends with CONFIG_PENDING = false
    await waitForValue(rfd, `${SWITCH_SERIAL}:0`, 'CONFIG_PENDING', false, timeout);
    await rfd.call('setInstallMode', [false]);
    return {newDevices};
}

/**
 * Polls getValue until it returns `expected`.
 */
export async function waitForValue(rfd, address, key, expected, timeout = 15000) {
    const until = Date.now() + timeout;
    let last;
    while (Date.now() < until) {
        try {
            last = await rfd.call('getValue', [address, key], {timeout: 5000});
            if (last === expected) {
                return last;
            }
        } catch (error) {
            last = error;
        }
        await sleep(250);
    }
    throw new Error(
        `${address} ${key} did not become ${expected} within ${timeout} ms (last: ${JSON.stringify(last)})`,
    );
}

/**
 * Waits for an event(interfaceId, address, key, value) at the receiver matching address and key (and value when
 * given), looking from `from` onwards in the receiver's record.
 */
export async function waitForEvent(receiver, address, key, value, {timeout = 15000, from = 0} = {}) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        const found = receiver.received
            .slice(from)
            .find(
                (r) =>
                    r.method === 'event' &&
                    r.params[1] === address &&
                    r.params[2] === key &&
                    (value === undefined || r.params[3] === value),
            );
        if (found) {
            return found;
        }
        await sleep(100);
    }
    const seen = receiver.received
        .slice(from)
        .filter((r) => r.method === 'event')
        .map((r) => `${r.params[1]} ${r.params[2]}=${JSON.stringify(r.params[3])}`);
    throw new Error(
        `no event ${address} ${key}${value === undefined ? '' : `=${value}`} within ${timeout} ms; events: ${seen.join(', ') || 'none'}`,
    );
}

/** The events the receiver got for an address/key, as values in order. */
export function eventValues(receiver, address, key, from = 0) {
    return receiver.received
        .slice(from)
        .filter((r) => r.method === 'event' && r.params[1] === address && r.params[2] === key)
        .map((r) => r.params[3]);
}
