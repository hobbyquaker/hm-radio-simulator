/**
 * BidCoS airtime and the 1 % duty cycle, **computed** from the frame format - not measured (the RPI-RF-MOD calibration,
 * task "calibrate the module timing", replaces these with measured values where they differ).
 *
 * The on-air frame, from the CC1101 configuration the public BidCoS implementations use (culfw's `ASKSIN_CFG`,
 * Homegear's TICC1100, read as documentation): 2-FSK at MDMCFG4/MDMCFG3 = 0xC8/0x93 with a 26 MHz crystal, i.e.
 * (256 + 147) * 2^8 / 2^28 * 26 MHz = 9992.6 baud; the default preamble of 4 bytes (MDMCFG1 NUM_PREAMBLE = 2), the
 * sync word 0xE9CA sent twice (MDMCFG2 SYNC_MODE = 3: 30 of 32 bits), the length byte, the telegram (counter, flags,
 * type, sender, receiver, payload) and a 16-bit CRC. So a telegram of n bytes (without the length byte) takes
 * (4 + 4 + 1 + n + 2) * 8 / 9992.6 s, 0.8 ms per byte: a 14-byte switch command 20.0 ms, a 10-byte ACK 16.8 ms.
 *
 * Gaps: culfw waits 10 ms before it transmits (after its clear-channel check) and a burst telegram (for devices that
 * only listen every ~300 ms) carries a 360 ms preamble ("According to ELV, devices get activated every 300ms, so send
 * burst for 360ms", culfw rf_asksin.c). The device's turnaround before its ACK is taken as the same 10 ms.
 *
 * The duty cycle: the 868.0-868.6 MHz SRD sub-band allows 1 % transmit time per hour - 36 s of airtime. Only what the
 * central transmits counts against its own budget; the devices' ACKs count against theirs.
 *
 * Measured 2026-10-11 on an RPI-RF-MOD (through multimacd), which confirms the model: 200 acknowledged switch commands
 * raised the module's duty cycle from 14.0 to 25.5 % - 0.0575 % (20.7 ms of the 36 s) per command against the 20.0 ms
 * computed here; the devices' ACKs and ~150 telegrams of other devices heard in 30 minutes did not count (the value
 * stayed flat); the value falls again about an hour later (a sliding hour). The module reports in half-percent steps
 * (GETDUTYCYCLE's byte is twice the percentage). Not measured: the limit itself (refuseAt stays chosen).
 */

/** 2-FSK symbol rate of the BidCoS CC1101 setup, in bit/s (computed, see above). */
export const BIT_RATE = ((256 + 0x93) * 2 ** 0x08 * 26e6) / 2 ** 28;

export const FRAME = Object.freeze({
    preambleBytes: 4,
    syncBytes: 4,
    lengthBytes: 1,
    crcBytes: 2,
    /** the wake-up preamble of a burst telegram */
    burstMs: 360,
    /** culfw's wait before transmitting; also used as the device's turnaround before its ACK (chosen) */
    gapMs: 10,
});

/** The 1 % duty cycle: 36 s of airtime per hour. */
export const DUTY_CYCLE = Object.freeze({limit: 0.01, windowMs: 3600 * 1000});

/**
 * Airtime of one telegram on the air, in ms.
 * @param {number} bytes the telegram's length without the length byte (counter .. payload)
 * @param {{burst?: boolean}} [options]
 */
export function telegramAirtimeMs(bytes, {burst = false} = {}) {
    const total = FRAME.preambleBytes + FRAME.syncBytes + FRAME.lengthBytes + bytes + FRAME.crcBytes;
    return (total * 8 * 1000) / BIT_RATE + (burst ? FRAME.burstMs : 0);
}

/**
 * One exchange - the central's telegram, the device's answer - including the gaps: gap, command, gap, answer.
 * @param {number} commandBytes
 * @param {number} answerBytes 0 for a telegram without an answer
 * @param {{burst?: boolean}} [options]
 */
export function exchangeMs(commandBytes, answerBytes, options = {}) {
    let ms = FRAME.gapMs + telegramAirtimeMs(commandBytes, options);
    if (answerBytes > 0) {
        ms += FRAME.gapMs + telegramAirtimeMs(answerBytes);
    }
    return ms;
}

/**
 * The airtime the central has used in a sliding window, and how much of its 1 % that is. `windowMs` can be scaled
 * down for tests (the budget is always 1 % of the window), so a suite can reach the limit in seconds instead of an
 * hour; a scaled window is a test device, not a real-world figure.
 */
export class DutyCycleMeter {
    constructor({windowMs = DUTY_CYCLE.windowMs, limit = DUTY_CYCLE.limit, now = () => Date.now()} = {}) {
        this.windowMs = windowMs;
        this.limit = limit;
        this.now = now;
        /** @type {Array<{at: number, ms: number}>} */
        this.entries = [];
        this.totalMs = 0;
    }

    /** The airtime budget of the window, in ms. */
    get budgetMs() {
        return this.windowMs * this.limit;
    }

    prune(at = this.now()) {
        while (this.entries.length && this.entries[0].at <= at - this.windowMs) {
            this.entries.shift();
        }
    }

    /** Adds airtime used now. */
    add(ms, at = this.now()) {
        this.entries.push({at, ms});
        this.totalMs += ms;
        this.prune(at);
    }

    /** The airtime used in the window, in ms. */
    usedMs(at = this.now()) {
        this.prune(at);
        return this.entries.reduce((s, e) => s + e.ms, 0);
    }

    /** The share of the budget used, in percent (100 = the 1 % is spent). */
    percent(at = this.now()) {
        return (this.usedMs(at) / this.budgetMs) * 100;
    }
}
