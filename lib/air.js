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
import {DutyCycleMeter, telegramAirtimeMs, FRAME} from './airtime.js';
import {BIDCOS_STATUS} from './commands.js';
import {decodeTelegram, encodeTelegram, CTRL, FT, CONFIG, ACK, INFO, BROADCAST} from './telegram.js';
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
     * @param {{module: RadioModule, eventGapMs?: number, absentFails?: boolean, airtime?: {windowMs?: number, refuseAt?: number, retries?: number}|null}} options
     *   `airtime`: model the channel - each send takes its computed airtime (lib/airtime.js: the central's telegram,
     *   the gaps, the device's answer), sends are serialised, the central's transmit time goes into a 1 % duty-cycle
     *   meter over `windowMs` (default one hour; scaled down for tests) which the module reports as its duty cycle, and
     *   at `refuseAt` percent (default 100, chosen) the module refuses with SEND_FAILED_DUTYCYCLE - if its duty-cycle
     *   check is on (`enforce: 'module-flag'`, the default: on unless DUTYCYCLE_ON_OFF switched it off - rfd's
     *   setDutyCycleCheck(false) is compiled out of its production build) or always (`enforce: 'always'`); the reported duty cycle is capped at `reportCap` (default 100); a send nobody
     *   acknowledges costs `retries` (default 3, chosen) transmissions. All computed, not measured.
     *   `absentFails`: a telegram
     *   that expects an acknowledgement (BIDI) to an address no device has ends in SEND_FAILED after the module's
     *   failDelayMs, as on a real module that runs out of retries; by default it is reported "sent" (nobody there to
     *   say otherwise), which is what the earlier stages rely on.
     *   `modules`: several modules on one air (rfd with two interfaces): each module's sends reach the devices in its
     *   range, a device's own telegrams and its answers reach every module in range, each with that module's RSSI
     *   (`setRssi(device, module, rssi)`; null = out of range; default the device's `rssi`). `module` is then the
     *   first of them; the airtime model and the key provider use it.
     */
    constructor({module, modules = null, eventGapMs = 20, absentFails = false, airtime = null}) {
        super();
        this.airtime = airtime ? {refuseAt: 100, retries: 3, enforce: 'module-flag', reportCap: 100, ...airtime} : null;
        this.meter = airtime ? new DutyCycleMeter({windowMs: airtime.windowMs}) : null;
        /** @type {Promise<unknown>} the channel: one send at a time */
        this.channel = Promise.resolve();
        this.reportedDuty = 0;
        /** @type {Array<{at: number, airtimeMs: number, status: string}>} every metered send */
        this.sends = [];
        /** @type {RadioModule[]} */
        this.modules = modules ? [...modules] : [module];
        this.module = this.modules[0];
        /** @type {Map<number, Map<RadioModule, number|null>>} device address -> module -> RSSI (null: out of range) */
        this.rssiMap = new Map();
        /** @type {RadioModule[]|null} the order in which the modules receive a device's telegram (default `modules`) */
        this.receiveOrder = null;
        /** Milliseconds between one module's reception of a device's telegram and the next one's (0: all at once). */
        this.moduleGapMs = 0;
        this.eventGapMs = eventGapMs;
        this.absentFails = absentFails;
        /** @type {Map<number, import('./device.js').BidcosDevice>} */
        this.devices = new Map();
        /** @type {Array<{at: number, dir: 'tx'|'rx', name: string, hex: string}>} tx = from the daemon */
        this.trace = [];
        /** @type {Array<{at: number, address: number, lazy: boolean}>} every wake-up the module sent */
        this.wakeups = [];
        /** @type {Array<{status: number}>} statuses forced on the next sends (e.g. SEND_FAILED_DUTYCYCLE) */
        this.forcedStatuses = [];
        /** @type {Map<object, Array<[object, Uint8Array]>>} further answers, sent once the module wrote its status */
        this.pending = new Map();
        for (const m of this.modules) {
            this.attachModule(m);
        }
        this.hook = this.module.air;
    }

    /** Makes the air the module's air hook. */
    attachModule(m) {
        m.air = (request) => this.send(request, m);
        // the status frame goes first; the device's further answers follow it as events (a timer armed before the
        // status could otherwise overtake it under load)
        m.on('telegramResult', ({request}) => {
            const pairs = this.pending.get(request);
            if (pairs) {
                this.pending.delete(request);
                this.scheduleEvents(pairs, this.eventGapMs);
            }
        });
    }

    /**
     * The RSSI at which a module hears a device (and the device the module), or null when it is out of range.
     * @param {import('./device.js').BidcosDevice} device
     * @param {RadioModule} m
     */
    rssi(device, m = this.module) {
        const perModule = this.rssiMap.get(device.address);
        if (perModule && perModule.has(m)) {
            return perModule.get(m);
        }
        return device.rssi;
    }

    /**
     * Sets the RSSI between a device and one module; null puts the device out of that module's range.
     * @param {import('./device.js').BidcosDevice} device
     * @param {RadioModule} m
     * @param {number|null} rssi
     */
    setRssi(device, m, rssi) {
        if (!this.rssiMap.has(device.address)) {
            this.rssiMap.set(device.address, new Map());
        }
        this.rssiMap.get(device.address).set(m, rssi);
    }

    /** The modules that hear a device, in the order of `modules`. */
    modulesInRange(device) {
        return this.modules.filter((m) => this.rssi(device, m) !== null);
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
    async send(request, m = this.module) {
        if (!this.airtime) {
            return this.deliver(request, m);
        }
        const run = this.channel.then(() => this.deliverMetered(request, m));
        this.channel = run.catch(() => {});
        return run;
    }

    /** A send on the modelled channel: refused at the duty-cycle limit, else delivered with computed delays. */
    async deliverMetered(request, m = this.module) {
        const percent = this.meter.percent();
        const enforced = this.airtime.enforce === 'always' || m.dutyCycleCheck !== false;
        if (enforced && percent >= this.airtime.refuseAt) {
            this.record('tx', request.raw, null, `refused: duty cycle ${percent.toFixed(0)} %`);
            this.sends.push({at: Date.now(), airtimeMs: 0, status: 'duty-cycle'});
            await sleep(2);
            return {status: BIDCOS_STATUS.SEND_FAILED_DUTYCYCLE};
        }
        const result = await this.deliver(request, m);
        const duty = Math.min(this.airtime.reportCap, this.meter.percent());
        if (Math.abs(duty - this.reportedDuty) >= 1) {
            this.reportedDuty = duty;
            m.sendDutyCycleEvent(duty);
        }
        return result;
    }

    /**
     * The time a send takes and what it costs: with `airtime`, the computed airtime (the central's telegram after a
     * gap, then the answer after a gap; `retries` transmissions when nobody answers), metered; else the module's
     * declared delays.
     * @param {'sent'|'answered'|'failed'} outcome
     */
    async wait(outcome, request, answer = null, module = this.module) {
        const burst = isBurst(request);
        if (!this.airtime) {
            const ms =
                outcome === 'sent'
                    ? module.options.sendDelayMs
                    : outcome === 'answered'
                      ? module.options.ackDelayMs
                      : module.options.failDelayMs;
            // a burst telegram carries the 360 ms wake-up preamble on top (computed, lib/airtime.js)
            await sleep(ms + (burst && outcome !== 'failed' ? FRAME.burstMs : 0));
            return;
        }
        const tx = FRAME.gapMs + telegramAirtimeMs(request.raw.length, {burst});
        const tries = outcome === 'failed' ? this.airtime.retries : 1;
        let ms = tx * tries;
        if (outcome === 'answered' && answer) {
            ms += FRAME.gapMs + telegramAirtimeMs(answer.length);
        }
        if (outcome === 'failed') {
            // after each try the module waits for an ACK that does not come (chosen: an ACK's airtime plus a gap)
            ms += tries * (FRAME.gapMs + telegramAirtimeMs(10));
        }
        this.meter.add((tx - FRAME.gapMs) * tries);
        this.sends.push({at: Date.now(), airtimeMs: ms, status: outcome});
        await sleep(ms);
    }

    /** The send itself (without the channel model's serialisation). */
    async deliver(request, module = this.module) {
        const t = request.telegram;
        const burst = isBurst(request);
        const known = t.dst === BROADCAST ? [...this.devices.values()] : [this.devices.get(t.dst)].filter(Boolean);
        // a device out of this module's range is as good as absent - but it exists, so a send to it fails
        const targets = known.filter((d) => this.rssi(d, module) !== null);
        const outOfRange = t.dst !== BROADCAST && known.length > 0 && targets.length === 0;
        this.record('tx', request.raw, targets[0] || null);
        const forced = this.forcedStatuses.shift();
        if (forced) {
            await sleep(module.options.sendDelayMs);
            return {status: forced.status};
        }
        if (targets.length === 0 && (this.absentFails || outOfRange) && t.ctrl & CTRL.BIDI && t.dst !== BROADCAST) {
            await this.wait('failed', request, null, module);
            return {status: BIDCOS_STATUS.SEND_FAILED};
        }
        if (targets.length === 0 || !(t.ctrl & CTRL.BIDI)) {
            // nobody listens, or no acknowledgement expected: deliver and report "sent"
            const responses = targets
                .filter((d) => d.hears({burst}))
                .flatMap((d) => d.receive(request.raw).map((r) => [d, r]));
            await this.wait('sent', request, null, module);
            if (responses.length) {
                this.pending.set(request, responses);
            }
            return {status: BIDCOS_STATUS.TELEGRAM_SENT};
        }
        const device = targets[0];
        if (!device.hears({burst})) {
            // not there, or asleep: the module retries on the air and gives up - SEND_FAILED, inside rfd's 4 s window
            await this.wait('failed', request, null, module);
            return {status: BIDCOS_STATUS.SEND_FAILED};
        }
        const responses = device.receive(request.raw);
        if (responses.length === 0) {
            if (this.airtime) {
                await this.wait('failed', request, null, module);
            } else {
                await sleep(module.options.ackDelayMs);
                await sleep(Math.max(0, module.options.failDelayMs - module.options.ackDelayMs));
            }
            return {status: BIDCOS_STATUS.SEND_FAILED};
        }
        await this.wait('answered', request, responses[0], module);
        // a sleeping device's window runs from the end of the exchange (after a burst's preamble too)
        renewWindow(device);
        const [first, ...rest] = responses;
        this.record('rx', first, device);
        if (isChallenge(first)) {
            return this.handshake(request, device, first, module);
        }
        this.overhear(device, first, module);
        if (rest.length) {
            this.pending.set(
                request,
                rest.map((r) => [device, r]),
            );
        }
        return RadioModule.answered(first, {rssi: this.rssi(device, module)});
    }

    /**
     * The other modules in range hear a device's answer to one module's send, and report it as an event (rfd uses
     * such a frame only for its roaming decision).
     */
    overhear(device, telegram, sender) {
        for (const m of this.modulesInRange(device)) {
            if (m !== sender) {
                m.sendEvent(telegram, {rssi: this.rssi(device, m)});
            }
        }
    }

    /**
     * The module's part of the AES handshake (firmware on real hardware): answer the device's challenge with the
     * key rfd set for the index the device named, check the signed acknowledgement, report the outcome.
     */
    async handshake(request, device, challengeTelegram, module = this.module) {
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
        return RadioModule.authenticated(true, {keyIndex, rssi: this.rssi(device, module), telegram: answers[0]});
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
        device.transmitted();
        // every module in range receives it (each reports it with its own RSSI), in the order of `receiveOrder` or
        // `modules`; with `moduleGapMs` one after the other, which decides the copy rfd sees first
        const order = (this.receiveOrder || this.modules).filter((m) => this.rssi(device, m) !== null);
        if (this.moduleGapMs > 0 && order.length > 1) {
            order.slice(1).forEach((m, i) => {
                setTimeout(() => this.receiveAt(m, device, telegram), (i + 1) * this.moduleGapMs);
            });
            return order.length ? this.receiveAt(order[0], device, telegram) : false;
        }
        const results = order.map((m) => this.receiveAt(m, device, telegram));
        return results.length ? results[0] : false;
    }

    /** One module receives a device's own telegram: wake-up, authentication, the event. */
    receiveAt(m, device, telegram) {
        const rssi = this.rssi(device, m);
        const wokenUp = this.wakeIfRequested(device, telegram, m);
        const policy = m.authentication.get(device.address);
        if (device.aes && policy && policy.channels.size > 0) {
            // authenticate when the event's channel is under authentication (any channel when it cannot be told)
            const match = matchFrame(device.description, Buffer.from(telegram), 'from_device');
            const channel = match ? match.channel : null;
            if (channel === null || policy.channels.has(channel)) {
                return this.authenticatedEvent(device, telegram, {wokenUp, module: m});
            }
        }
        return m.sendEvent(telegram, {rssi, wokenUp});
    }

    /**
     * The module's wake-up (firmware on real hardware): when rfd asked it to wake this device (ADD_LINK_PEER with the
     * wake-up flag), the module answers the device's own telegram with a WAKEUP telegram - type 0x12, flags
     * RPT_ENABLE|BIDI|WAKEUP, the device's counter, as FHEM's CUL_HM sends it ("A112", read as documentation) - so the
     * device keeps its receiver on, and reports the event with the WOKEN_UP flag (0x10), on which rfd sends what it
     * queued and commits pending configuration (RFDevice::ProcessIncomingFrame). The request stays until rfd clears it
     * with another ADD_LINK_PEER (chosen: the firmware's own bookkeeping is not public); a lazy-config request is
     * treated the same (chosen, same reason).
     * @returns {boolean} whether the device was woken up
     */
    wakeIfRequested(device, telegram, m = this.module) {
        const request = m.wakeupRequest(device.address);
        if (!request) {
            return false;
        }
        const t = decodeTelegram(telegram);
        const wakeup = encodeTelegram({
            counter: t ? t.counter : 0,
            ctrl: CTRL.RPT_ENABLE | CTRL.BIDI | CTRL.WAKEUP,
            type: FT.WAKEUP,
            src: m.rfAddress ?? 0,
            dst: device.address,
            payload: [],
        });
        this.record('tx', wakeup, device, `WAKEUP${request.lazy ? ' (lazy config)' : ''}`);
        const answers = device.receive(wakeup);
        if (answers.length) {
            this.record('rx', answers[0], device);
        }
        this.wakeups.push({at: Date.now(), address: device.address, lazy: request.lazy});
        return true;
    }

    /**
     * An event from a device whose channels rfd put under authentication: the module challenges the device, checks
     * its response and reports the event with the authentication status and key index (the module firmware's job on
     * real hardware). Without the key index in the module's table the status is KEY_INDEX_UNKNOWN.
     */
    authenticatedEvent(device, telegram, {wokenUp = false, module = this.module} = {}) {
        const rssi = this.rssi(device, module);
        const m = decodeTelegram(telegram);
        const keyIndex = device.aesKeyIndex;
        const key = module.keyTable.get(keyIndex);
        if (!key) {
            this.record('tx', Buffer.alloc(0), device, `AES: no key for index ${keyIndex}`);
            return module.sendEvent(telegram, {
                rssi,
                auth: EVENT_AUTH.KEY_INDEX_UNKNOWN,
                keyIndex,
                wokenUp,
            });
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
            return module.sendEvent(telegram, {rssi, auth: EVENT_AUTH.AUTH_FAILED, keyIndex, wokenUp});
        }
        const a = signedAckFrame(m, check.pd);
        this.record('tx', a, device, 'ACK (signed)');
        device.receive(a);
        return module.sendEvent(telegram, {rssi, auth: EVENT_AUTH.AUTH_SUCCESSFUL, keyIndex, wokenUp});
    }

    /**
     * The device presses its config button: the pairing announcement goes out as a broadcast, and a sleeping device
     * stays in config mode (receiver on) for its configModeMs.
     */
    announce(device) {
        if (device.sleeps) {
            device.wake(device.configModeMs);
        }
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

/** Whether the module sends the telegram as a burst (rfd's burst-mode byte, or the telegram's own BURST flag). */
function isBurst(request) {
    return Boolean(request.burst) || Boolean(request.telegram.ctrl & CTRL.BURST);
}

/** Restarts a sleeping device's receive window (it heard a telegram that just ended). */
function renewWindow(device) {
    if (device.sleeps) {
        device.wake();
    }
}
