/**
 * The virtual air between the simulated module and the simulated devices. It is the module's `air` hook: a
 * SEND_TELEGRAM is delivered to the addressed device (or to all for a broadcast), the device's first answer comes
 * back as the module's TELEGRAM_SENT_RECVD_ACK status (the module reports the first telegram from the destination as
 * the acknowledgement, whatever its type), further answers follow as EVENT frames, and a device that is "not there"
 * costs the module its retries and ends in SEND_FAILED. Devices send on their own through `transmit()`.
 *
 * The delays are the module's declared defaults (RadioModule DEFAULTS: ackDelayMs, sendDelayMs, failDelayMs), all
 * chosen, not measured; rfd waits 4000 ms for the status (defaultResponseTimeout) and keeps a 1500 ms window for
 * further responses after a send (WAIT_TIME_DEFAULT in BidcosFrameWaitTime.h).
 *
 * Every telegram crossing the air is recorded in `trace` (frame names, not counters) so a run can be compared with
 * one against another OpenCCU-Base ref.
 */

import {EventEmitter} from 'node:events';
import {RadioModule} from './module.js';
import {BIDCOS_STATUS} from './commands.js';
import {decodeTelegram, CTRL, FT, CONFIG, ACK, INFO, BROADCAST} from './telegram.js';
import {matchFrame} from './rftypes.js';
import {isChallenge, responseFrame, verifySignature, challengeFrame, verifyResponse, signedAckFrame} from './aes.js';
import {EVENT_AUTH} from './commands.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONFIG_NAMES = Object.fromEntries(Object.entries(CONFIG).map(([k, v]) => [v, `CONFIG_${k}`]));
const ACK_NAMES = Object.fromEntries(Object.entries(ACK).map(([k, v]) => [v, k]));
const INFO_NAMES = Object.fromEntries(Object.entries(INFO).map(([k, v]) => [v, `INFO_${k}`]));

/**
 * A readable name for a telegram: the XML frame id when a device description knows it, else the protocol name.
 * @param {Uint8Array} bytes
 * @param {object} [description] an rftypes description to try the XML frames against
 */
export function describeTelegram(bytes, description = null) {
    const t = decodeTelegram(bytes);
    if (!t) {
        return 'invalid';
    }
    const p = t.payload;
    let name;
    switch (t.type) {
        case FT.SYSINFO:
            name = 'SYSINFO';
            break;
        case FT.CONFIG:
            name = CONFIG_NAMES[p[1]] || `CONFIG_${(p[1] ?? 0).toString(16)}`;
            if (p[1] === CONFIG.STATUS_REQ) {
                name = 'STATUS_REQ';
            }
            break;
        case FT.ACK_OR_NACK:
            name = ACK_NAMES[p[0]] || `ACK_${(p[0] ?? 0).toString(16)}`;
            break;
        case FT.AES_CONTAINER:
            name = 'AES_CONTAINER';
            break;
        case FT.AES_SOLUTION:
            name = 'AES_SOLUTION';
            break;
        case FT.SWITCH:
            name = 'SWITCH';
            break;
        case FT.WAKEUP:
            name = 'WAKEUP';
            break;
        case FT.INFO:
            name = INFO_NAMES[p[0]] || `INFO_${(p[0] ?? 0).toString(16)}`;
            break;
        case FT.TIME:
            name = 'TIME';
            break;
        default:
            name = `TYPE_${t.type.toString(16).padStart(2, '0')}`;
    }
    if (description) {
        const direction = t.type === FT.CENTRAL || t.type === FT.CONFIG ? 'to_device' : 'from_device';
        const match = matchFrame(description, Buffer.from(bytes), direction);
        if (match && (t.type === FT.CENTRAL || t.type === FT.INFO || t.type === FT.ACK_OR_NACK)) {
            const values = Object.entries(match.values)
                .map(([k, v]) => `${k}=${v}`)
                .join(' ');
            name = `${match.frame.id}${match.channel !== null ? ` ch${match.channel}` : ''}${values ? ' ' + values : ''}`;
        }
    }
    const flags = [];
    if (t.ctrl & CTRL.BIDI) {
        flags.push('bidi');
    }
    if (t.ctrl & CTRL.BURST) {
        flags.push('burst');
    }
    if (t.ctrl & CTRL.BCAST) {
        flags.push('bcast');
    }
    return `${name}${flags.length ? ` [${flags.join(',')}]` : ''}`;
}

export class Air extends EventEmitter {
    /**
     * @param {{module: RadioModule, eventGapMs?: number, absentFails?: boolean}} options `absentFails`: a telegram
     *   that expects an acknowledgement (BIDI) to an address no device has ends in SEND_FAILED after the module's
     *   failDelayMs, as on a real module that runs out of retries; by default it is reported "sent" (nobody there to
     *   say otherwise), which is what the earlier stages rely on
     */
    constructor({module, eventGapMs = 20, absentFails = false}) {
        super();
        this.module = module;
        this.eventGapMs = eventGapMs;
        this.absentFails = absentFails;
        /** @type {Map<number, import('./device.js').BidcosDevice>} */
        this.devices = new Map();
        /** @type {Array<{at: number, dir: 'tx'|'rx', name: string, hex: string}>} tx = from the daemon */
        this.trace = [];
        /** @type {Array<{status: number}>} statuses forced on the next sends (e.g. SEND_FAILED_DUTYCYCLE) */
        this.forcedStatuses = [];
        /** @type {Map<object, Array<[object, Uint8Array]>>} further answers, sent once the module wrote its status */
        this.pending = new Map();
        this.hook = (request) => this.send(request);
        module.air = this.hook;
        // the status frame goes first; the device's further answers follow it as events (a timer armed before the
        // status could otherwise overtake it under load)
        module.on('telegramResult', ({request}) => {
            const pairs = this.pending.get(request);
            if (pairs) {
                this.pending.delete(request);
                this.scheduleEvents(pairs, this.eventGapMs);
            }
        });
    }

    add(device) {
        this.devices.set(device.address, device);
        // the simulation's shortcut for the key exchange: an AES device without a key of its own uses the central's
        device.keyProvider = (index) => this.module.keyTable.get(index) || null;
        device.keyIndexProvider = () => (this.module.currentKeyIndex ? this.module.currentKeyIndex : null);
        return device;
    }

    remove(device) {
        this.devices.delete(device.address);
    }

    /** Forces the status the module reports for the next SEND_TELEGRAM; the telegram does not reach the air. */
    forceStatus(status, times = 1) {
        for (let i = 0; i < times; i++) {
            this.forcedStatuses.push({status});
        }
    }

    record(dir, bytes, device, name = null) {
        const entry = {
            at: Date.now(),
            dir,
            name: name ?? describeTelegram(bytes, device ? device.description : null),
            hex: Buffer.from(bytes).toString('hex'),
        };
        this.trace.push(entry);
        this.emit('trace', entry);
        return entry;
    }

    /** The trace as lines "tx NAME" / "rx NAME", without counters or timing. */
    traceLines() {
        return this.trace.map((e) => `${e.dir} ${e.name}`);
    }

    /**
     * The module's air hook.
     * @param {{waitMs: number, burst: number, telegram: object, raw: Buffer}} request
     */
    async send(request) {
        const t = request.telegram;
        const module = this.module;
        const targets = t.dst === BROADCAST ? [...this.devices.values()] : [this.devices.get(t.dst)].filter(Boolean);
        this.record('tx', request.raw, targets[0] || null);
        const forced = this.forcedStatuses.shift();
        if (forced) {
            await sleep(module.options.sendDelayMs);
            return {status: forced.status};
        }
        if (targets.length === 0 && this.absentFails && t.ctrl & CTRL.BIDI && t.dst !== BROADCAST) {
            await sleep(module.options.failDelayMs);
            return {status: BIDCOS_STATUS.SEND_FAILED};
        }
        if (targets.length === 0 || !(t.ctrl & CTRL.BIDI)) {
            // nobody listens, or no acknowledgement expected: deliver and report "sent"
            const responses = targets
                .filter((d) => d.answering)
                .flatMap((d) => d.receive(request.raw).map((r) => [d, r]));
            await sleep(module.options.sendDelayMs);
            if (responses.length) {
                this.pending.set(request, responses);
            }
            return {status: BIDCOS_STATUS.TELEGRAM_SENT};
        }
        const device = targets[0];
        if (!device.answering) {
            // the module retries on the air and gives up: SEND_FAILED, well inside rfd's 4 s window
            await sleep(module.options.failDelayMs);
            return {status: BIDCOS_STATUS.SEND_FAILED};
        }
        const responses = device.receive(request.raw);
        await sleep(module.options.ackDelayMs);
        if (responses.length === 0) {
            await sleep(Math.max(0, module.options.failDelayMs - module.options.ackDelayMs));
            return {status: BIDCOS_STATUS.SEND_FAILED};
        }
        const [first, ...rest] = responses;
        this.record('rx', first, device);
        if (isChallenge(first)) {
            return this.handshake(request, device, first);
        }
        if (rest.length) {
            this.pending.set(
                request,
                rest.map((r) => [device, r]),
            );
        }
        return RadioModule.answered(first, {rssi: device.rssi});
    }

    /**
     * The module's part of the AES handshake (firmware on real hardware): answer the device's challenge with the
     * key rfd set for the index the device named, check the signed acknowledgement, report the outcome.
     */
    async handshake(request, device, challengeTelegram) {
        const module = this.module;
        const c = decodeTelegram(challengeTelegram);
        const keyIndex = c.payload[7];
        const key = module.keyTable.get(keyIndex);
        if (!key) {
            this.record('tx', Buffer.alloc(0), device, `AES: no key for index ${keyIndex}`);
            await sleep(module.options.ackDelayMs);
            return RadioModule.authenticated(false, {keyIndex});
        }
        const {telegram: r, pd} = responseFrame(key, c.payload.subarray(1, 7), request.telegram);
        this.record('tx', r, device);
        const answers = device.receive(r);
        await sleep(module.options.ackDelayMs);
        if (answers.length === 0 || !verifySignature(answers[0], pd)) {
            this.record('rx', Buffer.alloc(0), device, 'AES: no signed acknowledgement');
            return RadioModule.authenticated(false, {keyIndex});
        }
        this.record('rx', answers[0], device, 'ACK (signed)');
        if (answers.length > 1) {
            this.pending.set(
                request,
                answers.slice(1).map((a) => [device, a]),
            );
        }
        return RadioModule.authenticated(true, {keyIndex, rssi: device.rssi, telegram: answers[0]});
    }

    scheduleEvents(pairs, firstDelayMs) {
        pairs.forEach(([device, telegram], i) => {
            setTimeout(() => this.transmit(device, telegram), firstDelayMs + i * this.eventGapMs);
        });
    }

    /**
     * A telegram the device sends on its own (a status report, the pairing announcement): an EVENT to the daemon.
     * @param {import('./device.js').BidcosDevice} device
     * @param {Uint8Array} telegram
     */
    transmit(device, telegram) {
        this.record('rx', telegram, device);
        const policy = this.module.authentication.get(device.address);
        if (device.aes && policy && policy.channels.size > 0) {
            // authenticate when the event's channel is under authentication (any channel when it cannot be told)
            const match = matchFrame(device.description, Buffer.from(telegram), 'from_device');
            const channel = match ? match.channel : null;
            if (channel === null || policy.channels.has(channel)) {
                return this.authenticatedEvent(device, telegram);
            }
        }
        return this.module.sendEvent(telegram, {rssi: device.rssi});
    }

    /**
     * An event from a device whose channels rfd put under authentication: the module challenges the device, checks
     * its response and reports the event with the authentication status and key index (the module firmware's job on
     * real hardware). Without the key index in the module's table the status is KEY_INDEX_UNKNOWN.
     */
    authenticatedEvent(device, telegram) {
        const module = this.module;
        const m = decodeTelegram(telegram);
        const keyIndex = device.aesKeyIndex;
        const key = module.keyTable.get(keyIndex);
        if (!key) {
            this.record('tx', Buffer.alloc(0), device, `AES: no key for index ${keyIndex}`);
            return module.sendEvent(telegram, {rssi: device.rssi, auth: EVENT_AUTH.KEY_INDEX_UNKNOWN, keyIndex});
        }
        const {telegram: c, challenge} = challengeFrame(m, keyIndex);
        this.record('tx', c, device);
        const r = device.answerChallenge(m, challenge);
        if (r) {
            this.record('rx', r, device);
        }
        const check = r ? verifyResponse(key, challenge, m, decodeTelegram(r).payload) : {ok: false};
        if (!check.ok) {
            this.record('tx', Buffer.alloc(0), device, 'AES: response rejected');
            return module.sendEvent(telegram, {rssi: device.rssi, auth: EVENT_AUTH.AUTH_FAILED, keyIndex});
        }
        const a = signedAckFrame(m, check.pd);
        this.record('tx', a, device, 'ACK (signed)');
        device.receive(a);
        return module.sendEvent(telegram, {rssi: device.rssi, auth: EVENT_AUTH.AUTH_SUCCESSFUL, keyIndex});
    }

    /** The device presses its config button: the pairing announcement goes out as a broadcast. */
    announce(device) {
        return this.transmit(device, device.sysinfoTelegram());
    }

    /** The device reports a channel's status. */
    reportStatus(device, channel, options) {
        return this.transmit(device, device.statusTelegram(channel, options));
    }

    /** A remote's key press (RemoteBehaviour). */
    press(device, channel, options) {
        return this.transmit(device, device.behaviour.pressTelegram(device, channel, options));
    }
}
