/**
 * The simulated HomeMatic Wired (RS485) bus behind an HMW-LGW: `WiredBus` holds the devices, delivers the frames the
 * gateway got from hs485d and hands back what a device answers; `WiredDevice` is one device driven by an hs485types
 * description (the same reader as the radio devices, `rftypes.js`) with a 1 KiB EEPROM and a thin per-type
 * behaviour. Only public sources: the frames are what hs485d sends and expects (HS485Device.cpp, HS485Controller.cpp
 * of OpenCCU-Base) and what the descriptions declare.
 *
 * A wired frame, as the HMW-LGW carries it, is receiver (4), control byte (1), sender (4), payload; the payload's
 * first byte is the command character (the descriptions' `type="#x"`). hs485d asks a device `h` (type and hardware
 * version), `v` (firmware major and minor) - together the 4-byte sysinfo matched against `<supported_types>` - and
 * `n` (the serial, when the description has one); reads and writes the EEPROM with `R` addr(2) count, `W` addr(2)
 * count data and asks which EEPROM chunks are in use with `E` addr(2) blocksize count (answered `e` addr(2) blocksize
 * bitmap, a set bit = the chunk holds something). Actuator commands come from the description (`x` LEVEL_SET, `S`
 * LEVEL_GET → `i` INFO_LEVEL, `l` SET_LOCK, ...). `z`/`Z` are the sleep-mode broadcasts around a discovery.
 *
 * The control byte: bit 0 clear = an I-frame with the sender's tx counter in bits 1-2 and the rx counter in bits 5-6,
 * SYN (0x80) on the first frame to a peer; 0x19 = an ACK. hs485d drops an I-frame whose tx counter repeats without
 * SYN (`HS485Controller::CheckRxCounter`), so a device counts per peer.
 */

import {EventEmitter} from 'node:events';
import {matchFrame, buildFramePayload, frameById} from './rftypes.js';

export const WIRED_BROADCAST = 0xffffffff;
export const WIRED_CENTRAL = 0x00000001;

export const WCTRL = Object.freeze({
    IFRAME: 0x18,
    BOOT_IFRAME: 0x10,
    SYN: 0x80,
    ACK: 0x19,
});

/** Builds the 9-byte header + payload view the description reader expects (index 9 = the command character). */
export function wiredTelegram(receiver, ctrl, sender, payload) {
    const t = Buffer.alloc(9 + payload.length);
    t.writeUInt32BE(receiver >>> 0, 0);
    t[4] = ctrl;
    t.writeUInt32BE(sender >>> 0, 5);
    Buffer.from(payload).copy(t, 9);
    return t;
}

/** A frame's name for the trace: the description's frame id, or the command character. */
export function describeWired(payload, description, direction) {
    const p = Buffer.from(payload);
    if (p.length === 0) {
        return 'ACK';
    }
    if (description) {
        const m = matchFrame(description, wiredTelegram(0, 0, 0, p), direction);
        if (m) {
            return `${m.frame.id}${m.channel === null ? '' : ` ch${m.channel}`}`;
        }
    }
    const c = String.fromCharCode(p[0]);
    return /[A-Za-z]/.test(c) ? `'${c}'` : `0x${p[0].toString(16)}`;
}

/** The behaviour of the HMW-LC-Sw2-DR family: two keys (channels 1-2) and two switches (channels 3-4). */
export class WiredSwitchBehaviour {
    constructor() {
        /** @type {Map<number, {STATE: number, STATE_FLAGS: number, INHIBIT: number}>} */
        this.channels = new Map();
        this.keyCounters = new Map();
    }

    channel(index) {
        if (!this.channels.has(index)) {
            this.channels.set(index, {STATE: 0, STATE_FLAGS: 0, INHIBIT: 0});
        }
        return this.channels.get(index);
    }

    /**
     * A command the description knows: returns the answer - an ACK, or data (a frame payload).
     * @returns {{kind: 'ack'|'data'|'none', data?: Buffer, event?: {channel: number, frameId: string}}}
     */
    command(device, match) {
        const ch = match.channel ?? 0;
        switch (match.frame.id) {
            case 'LEVEL_SET': {
                const state = this.channel(ch);
                state.STATE = match.values.STATE ?? 0;
                return {kind: 'ack', event: {channel: ch, frameId: 'INFO_LEVEL'}};
            }
            case 'TOGGLE_INSTALL_TEST': {
                const state = this.channel(ch);
                state.STATE = state.STATE ? 0 : 200;
                return {kind: 'ack', event: {channel: ch, frameId: 'INFO_LEVEL'}};
            }
            case 'LEVEL_GET':
                return {kind: 'data', data: this.infoLevel(device, ch)};
            case 'SET_LOCK':
                this.channel(ch).INHIBIT = match.values.INHIBIT ?? 0;
                return {kind: 'ack'};
            default:
                return {kind: 'ack'};
        }
    }

    infoLevel(device, channel) {
        const state = this.channel(channel);
        return buildFramePayload(frameById(device.description, 'INFO_LEVEL'), {
            channel,
            values: {STATE: state.STATE, STATE_FLAGS: state.STATE_FLAGS},
        });
    }

    /** The payload of a key press: KEY_EVENT_SHORT / KEY_EVENT_LONG with the key's counter. */
    keyEvent(device, channel, {long = false, repeat = false} = {}) {
        if (!repeat) {
            this.keyCounters.set(channel, ((this.keyCounters.get(channel) ?? 0) + 1) & 0x3f);
        }
        const counter = this.keyCounters.get(channel) ?? 0;
        return buildFramePayload(frameById(device.description, long ? 'KEY_EVENT_LONG' : 'KEY_EVENT_SHORT'), {
            channel,
            values: {COUNTER: counter, TEST_COUNTER: counter},
        });
    }
}

export class WiredDevice extends EventEmitter {
    /**
     * @param {{address: number, serial?: string|null, description: object, typeId: string, sysinfo: number[],
     *   eepromSize?: number, behaviour?: object, answering?: boolean, infoDelayMs?: number}} options `sysinfo` are
     *   the four bytes hs485d gets for `h` and `v` (type, hardware version, firmware major, minor); `serial` null
     *   makes a device without one (hs485d then names it ELV<address>)
     */
    constructor({
        address,
        serial = null,
        description,
        typeId,
        sysinfo,
        eepromSize = 1024,
        behaviour = new WiredSwitchBehaviour(),
        answering = true,
        infoDelayMs = 60,
    }) {
        super();
        this.address = address >>> 0;
        this.serial = serial;
        this.description = description;
        this.typeId = typeId;
        this.sysinfo = Buffer.from(sysinfo);
        this.eeprom = Buffer.alloc(eepromSize, 0xff);
        this.behaviour = behaviour;
        this.answering = answering;
        this.infoDelayMs = infoDelayMs;
        /** @type {Map<number, {tx: number, rx: number, syn: boolean}>} the counters per peer */
        this.peers = new Map();
        /** @type {Array<{at: number, dir: 'rx'|'tx', name: string, hex: string}>} */
        this.trace = [];
        this.writes = 0;
    }

    counters(peer) {
        if (!this.peers.has(peer)) {
            this.peers.set(peer, {tx: 0, rx: 0, syn: true});
        }
        return this.peers.get(peer);
    }

    /** The control byte of the next I-frame to `peer`. */
    nextCtrl(peer) {
        const c = this.counters(peer);
        const ctrl = WCTRL.IFRAME | ((c.tx & 0x03) << 1) | ((c.rx & 0x03) << 5) | (c.syn ? WCTRL.SYN : 0);
        c.tx = (c.tx + 1) & 0x03;
        c.syn = false;
        return ctrl;
    }

    /**
     * A frame from the central (through the gateway). Returns the answer the bus passes back: `null` for no answer
     * (a broadcast, or the device not answering), else `{ctrl, data}` with an empty `data` for a plain ACK, and an
     * optional follow-up event the device sends on its own afterwards.
     * @param {number} sender
     * @param {number} ctrl
     * @param {Buffer} payload
     * @param {boolean} broadcast
     */
    handle(sender, ctrl, payload, broadcast) {
        this.trace.push({
            at: Date.now(),
            dir: 'rx',
            name: describeWired(payload, this.description, 'to_device'),
            hex: payload.toString('hex'),
        });
        if (!this.answering || payload.length === 0) {
            return null;
        }
        const c = this.counters(sender);
        if ((ctrl & 0x01) === 0) {
            c.rx = (ctrl >> 1) & 0x03;
        }
        const cmd = String.fromCharCode(payload[0]);
        const data = (bytes) => ({ctrl: this.nextCtrl(sender), data: Buffer.from(bytes)});
        const ack = () => ({ctrl: WCTRL.ACK, data: Buffer.alloc(0)});
        switch (cmd) {
            case 'z':
            case 'Z':
                return null; // sleep mode on/off: broadcasts, no answer
            case 'h':
                return data(this.sysinfo.subarray(0, 2));
            case 'v':
                return data(this.sysinfo.subarray(2, 4));
            case 'n':
                return this.serial ? data(Buffer.from(this.serial, 'ascii')) : ack();
            case 'R': {
                const address = payload.readUInt16BE(1);
                const count = payload[3];
                return data(this.eeprom.subarray(address, address + count));
            }
            case 'W': {
                const address = payload.readUInt16BE(1);
                const count = payload[3];
                payload.subarray(4, 4 + count).copy(this.eeprom, address);
                this.writes++;
                this.emit('eeprom', {address, count});
                return ack();
            }
            case 'E': {
                const address = payload.readUInt16BE(1);
                const blockSize = payload[3] || 1;
                const count = payload[4];
                const bits = Buffer.alloc(Math.ceil(count / 8));
                for (let i = 0; i < count; i++) {
                    const start = address + i * blockSize;
                    const chunk = this.eeprom.subarray(start, start + blockSize);
                    if (chunk.some((b) => b !== 0xff)) {
                        bits[i >> 3] |= 1 << (i & 7);
                    }
                }
                return data(Buffer.concat([Buffer.from([0x65]), payload.subarray(1, 4), bits]));
            }
            default: {
                if (broadcast) {
                    return null;
                }
                const match = matchFrame(
                    this.description,
                    wiredTelegram(this.address, ctrl, sender, payload),
                    'to_device',
                );
                if (!match) {
                    return ack();
                }
                const result = this.behaviour.command(this, match);
                if (result.event) {
                    setTimeout(() => this.sendInfo(result.event.channel, result.event.frameId), this.infoDelayMs);
                }
                return result.kind === 'data' ? data(result.data) : ack();
            }
        }
    }

    /** The device sends a frame of its own to the central: the bus turns it into the gateway's event. */
    transmit(payload, receiver = WIRED_CENTRAL) {
        const p = Buffer.from(payload);
        this.trace.push({
            at: Date.now(),
            dir: 'tx',
            name: describeWired(p, this.description, 'from_device'),
            hex: p.toString('hex'),
        });
        this.emit('frame', {receiver, ctrl: this.nextCtrl(receiver), payload: p});
    }

    sendInfo(channel, frameId = 'INFO_LEVEL') {
        if (frameId === 'INFO_LEVEL') {
            this.transmit(this.behaviour.infoLevel(this, channel));
        }
    }

    /** A key press on one of the device's key channels. */
    press(channel, options) {
        this.transmit(this.behaviour.keyEvent(this, channel, options));
    }

    /**
     * The announcement a device broadcasts (its config button, or power-up): `A`, a byte, the four sysinfo bytes,
     * then the serial - hs485d adds an unknown sender from it without a discovery (`HS485Manager::ProcessIncomingFrame`).
     */
    announce() {
        const parts = [Buffer.from([0x41, 0x00]), this.sysinfo];
        if (this.serial) {
            parts.push(Buffer.from(this.serial.padEnd(10, ' ').slice(0, 10), 'ascii'));
        }
        this.transmit(Buffer.concat(parts), WIRED_BROADCAST);
    }

    traceLines() {
        return this.trace.map((e) => `${e.dir} ${e.name}`);
    }
}

/**
 * The bus: devices by address; `deliver()` is what the gateway calls for an `S` command, `event` is what it listens
 * to for the devices' own frames.
 */
export class WiredBus extends EventEmitter {
    /** @param {{ackDelayMs?: number}} [options] the time a device takes to answer */
    constructor({ackDelayMs = 20} = {}) {
        super();
        this.ackDelayMs = ackDelayMs;
        /** @type {Map<number, WiredDevice>} */
        this.devices = new Map();
        /** @type {Array<{at: number, dir: 'tx'|'rx', address: number, name: string, hex: string}>} every frame on the bus */
        this.trace = [];
    }

    add(device) {
        this.devices.set(device.address, device);
        device.on('frame', ({receiver, ctrl, payload}) => {
            this.trace.push({
                at: Date.now(),
                dir: 'rx',
                address: device.address,
                name: describeWired(payload, device.description, 'from_device'),
                hex: payload.toString('hex'),
            });
            this.emit('event', {receiver, ctrl, sender: device.address, payload});
        });
        return device;
    }

    /** The addresses the gateway's discovery reports, lowest first. */
    addresses() {
        return [...this.devices.keys()].sort((a, b) => a - b);
    }

    /**
     * A frame from the central: delivered to the receiver (or every device for the broadcast address). Resolves with
     * the device's answer `{ctrl, data}` after the ack delay, or `null` when nothing answers.
     */
    deliver({receiver, ctrl, sender, payload}) {
        const broadcast = receiver === WIRED_BROADCAST;
        const targets = broadcast ? [...this.devices.values()] : [this.devices.get(receiver)].filter(Boolean);
        this.trace.push({
            at: Date.now(),
            dir: 'tx',
            address: receiver,
            name: describeWired(payload, targets[0] ? targets[0].description : null, 'to_device'),
            hex: payload.toString('hex'),
        });
        let answer = null;
        for (const device of targets) {
            const a = device.handle(sender, ctrl, payload, broadcast);
            if (a && !broadcast) {
                answer = a;
            }
        }
        return new Promise((resolve) => setTimeout(() => resolve(answer), this.ackDelayMs));
    }

    traceLines() {
        return this.trace.map((e) => `${e.dir} ${e.name}`);
    }
}
