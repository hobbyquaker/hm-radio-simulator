/**
 * A simulated BidCoS device behind the module: the generic protocol (pairing sysinfo, the config lists rfd writes and
 * reads, the peer lists, status requests, acknowledgements) plus a thin per-device behaviour that owns the channel
 * values and answers the commands the device's rftypes XML defines (LEVEL_SET → ACK_STATUS, LEVEL_GET → INFO_LEVEL).
 *
 * What rfd does with such a device is read from its own source: on a sysinfo in install mode it writes list 0 of
 * channel 0 (the central's address at index 10..12, bit 0 of index 2) with CONFIG_START / CONFIG_WRITE_INDEX /
 * CONFIG_END, exchanges the AES key for an AES-capable type (AES_CONTAINER frames, acknowledged), then reads the
 * lists it caches (CONFIG_PARAM_REQ → INFO_PARAM_RESPONSE_PAIRS ending in 00 00) and the peer list
 * (CONFIG_PEER_LIST_REQ → INFO_PEER_LIST ending in 00 00 00 00). A command frame gets an ACK_STATUS with the channel's
 * state; a status request (CONFIG_STATUS_REQ, "LEVEL_GET" in the XML) an INFO_LEVEL.
 *
 * Timing lives in the air (lib/air.js); the device itself is synchronous: it takes a telegram and returns the
 * telegrams it answers with.
 */

import {EventEmitter} from 'node:events';
import {encodeTelegram, decodeTelegram, CTRL, FT, CONFIG, ACK, INFO, BROADCAST} from './telegram.js';
import {matchFrame, buildFramePayload, frameById, sysinfoForType} from './rftypes.js';

const MAX_PAYLOAD = 17;

/**
 * The switch behaviour (HM-LC-Sw1-Pl and its relatives, rf_s.xml): one STATE per channel, 0 or 200, set by
 * LEVEL_SET, toggled by TOGGLE_INSTALL_TEST, reported in ACK_STATUS and INFO_LEVEL.
 */
export class SwitchBehaviour {
    constructor() {
        /** @type {Map<number, {STATE: number, STATE_FLAGS: number, INHIBIT: number}>} */
        this.channels = new Map();
    }

    channel(index) {
        if (!this.channels.has(index)) {
            this.channels.set(index, {STATE: 0, STATE_FLAGS: 0, INHIBIT: 0});
        }
        return this.channels.get(index);
    }

    /**
     * @param {object} device
     * @param {{frame: object, channel: number|null, values: Record<string, number>}} match
     * @returns {{kind: 'status'|'ack'|'nack'}}
     */
    command(device, match) {
        const ch = this.channel(match.channel ?? 1);
        switch (match.frame.id) {
            case 'LEVEL_SET':
                ch.STATE = match.values.STATE ?? ch.STATE;
                return {kind: 'status'};
            case 'SET_LOCK':
                ch.INHIBIT = match.values.INHIBIT ?? ch.INHIBIT;
                return {kind: 'status'};
            case 'TOGGLE_INSTALL_TEST':
                ch.STATE = ch.STATE ? 0 : 200;
                return {kind: 'status'};
            default:
                return {kind: 'ack'};
        }
    }

    /** The values the from_device frames (INFO_LEVEL, ACK_STATUS) are built from. */
    values(channel) {
        return {...this.channel(channel)};
    }

    /** The frame that reports a channel's status. */
    statusFrameId() {
        return 'INFO_LEVEL';
    }

    ackStatusFrameId() {
        return 'ACK_STATUS';
    }
}

export class BidcosDevice extends EventEmitter {
    /**
     * @param {{address: number, serial: string, description: object, typeId: string, behaviour?: object,
     *   firmware?: number, rssi?: number, answering?: boolean, peeringChannel?: number, channelCount?: number}} options
     *   `channelCount` is what a `count_from_sysinfo="23.0:1.0"` channel type reads from the announcement
     */
    constructor({
        address,
        serial,
        description,
        typeId,
        behaviour = new SwitchBehaviour(),
        firmware,
        rssi = -60,
        answering = true,
        peeringChannel = 1,
        channelCount = 1,
    }) {
        super();
        if (serial.length !== 10) {
            throw new Error(`a BidCoS serial has 10 characters: ${serial}`);
        }
        this.address = address;
        this.serial = serial;
        this.description = description;
        this.typeId = typeId;
        this.behaviour = behaviour;
        const sysinfo = sysinfoForType(description, typeId);
        this.firmware = firmware ?? sysinfo.firmware;
        this.typeCode = sysinfo.type;
        this.rssi = rssi;
        /** When false the device "is not there": the air reports SEND_FAILED for frames to it. */
        this.answering = answering;
        this.peeringChannel = peeringChannel;
        this.channelCount = channelCount;
        /** @type {Map<string, Map<number, number>>} "channel/peer/peerCh/list" -> index -> value */
        this.lists = new Map();
        /** @type {Map<number, Set<string>>} channel -> "address:channel" peers */
        this.peers = new Map();
        /** @type {{channel: number, peer: number, peerChannel: number, list: number}|null} the open CONFIG_START session */
        this.configSession = null;
        this.counter = 0;
        /** @type {Array<{at: number, dir: 'rx'|'tx', frame: string}>} */
        this.log = [];
        /** The central's address, learned from list 0 index 10..12 or from the first frame addressed to us. */
        this.central = null;
    }

    nextCounter() {
        this.counter = (this.counter + 1) & 0xff;
        return this.counter;
    }

    listKey(channel, peer, peerChannel, list) {
        return `${channel}/${peer}/${peerChannel}/${list}`;
    }

    /**
     * A config list as the device holds it.
     * @returns {Map<number, number>}
     */
    list(channel, list, peer = 0, peerChannel = 0) {
        const key = this.listKey(channel, peer, peerChannel, list);
        if (!this.lists.has(key)) {
            this.lists.set(key, new Map());
        }
        return this.lists.get(key);
    }

    /** The value of a config parameter by its paramset definition (lib/rftypes.js collects them). */
    configValue(channel, paramDef, peer = 0, peerChannel = 0) {
        const list = this.list(channel, paramDef.list, peer, peerChannel);
        const byte = list.get(paramDef.byte) ?? 0;
        return paramDef.bits >= 8 ? byte : (byte >> paramDef.bit) & ((1 << paramDef.bits) - 1);
    }

    /** The central's address as written into list 0 (index 10..12), or null. */
    pairedCentral() {
        const l = this.list(0, 0);
        if (!l.has(10) && !l.has(11) && !l.has(12)) {
            return null;
        }
        return ((l.get(10) ?? 0) << 16) | ((l.get(11) ?? 0) << 8) | (l.get(12) ?? 0);
    }

    // -----------------------------------------------------------------------------------------------------------
    // frames the device sends on its own

    /**
     * The pairing announcement (sysinfo, type 0x00): firmware, type code, serial, two zero bytes, the peering
     * channels (rfd expects a channel for this device class unless the XML says peering_sysinfo_expect_channel="false").
     * @param {number} [dst] BROADCAST for the config-button press
     */
    sysinfoTelegram(dst = BROADCAST) {
        const expectChannel = this.description.peeringSysinfoExpectChannel;
        const payload = Buffer.concat([
            Buffer.from([this.firmware & 0xff, (this.typeCode >> 8) & 0xff, this.typeCode & 0xff]),
            Buffer.from(this.serial, 'ascii'),
            // device code (22..23; byte 23 is the channel count the XML reads with count_from_sysinfo), peering channels
            Buffer.from([0x00, this.channelCount & 0xff, expectChannel ? this.peeringChannel : 0x00, 0x00]),
        ]);
        return encodeTelegram({
            counter: this.nextCounter(),
            ctrl: CTRL.RPT_ENABLE | CTRL.BCAST,
            type: FT.SYSINFO,
            src: this.address,
            dst,
            payload,
        });
    }

    /**
     * An unsolicited status report of a channel (INFO_LEVEL for a switch) to the central.
     * @param {number} channel
     * @param {{bidi?: boolean}} [options] with `bidi` the device expects an ACK from the central (the usual case)
     */
    statusTelegram(channel, {bidi = true} = {}) {
        const frame = frameById(this.description, this.behaviour.statusFrameId());
        return encodeTelegram({
            counter: this.nextCounter(),
            ctrl: CTRL.RPT_ENABLE | (bidi ? CTRL.BIDI : 0),
            type: frame.type,
            src: this.address,
            dst: this.central ?? BROADCAST,
            payload: buildFramePayload(frame, {channel, values: this.behaviour.values(channel)}),
        });
    }

    // -----------------------------------------------------------------------------------------------------------
    // frames the device receives

    /**
     * Handles a telegram addressed to this device (or a broadcast) and returns the telegrams it answers with, in
     * order; the first one is what the module reports as the acknowledgement.
     * @param {Uint8Array} bytes
     * @returns {Buffer[]}
     */
    receive(bytes) {
        const t = decodeTelegram(bytes);
        if (!t) {
            return [];
        }
        this.log.push({at: Date.now(), dir: 'rx', frame: Buffer.from(bytes).toString('hex')});
        if (t.dst !== this.address && t.dst !== BROADCAST) {
            return [];
        }
        if (t.dst === this.address && this.central === null && t.src !== 0) {
            this.central = t.src;
        }
        let responses;
        switch (t.type) {
            case FT.CONFIG:
                responses = this.handleConfig(t);
                break;
            case FT.ACK_OR_NACK:
                responses = []; // an ACK of our own status report
                break;
            case FT.AES_CONTAINER:
                responses = [this.ack(t)]; // the key exchange: accepted (the real crypto is stage 3)
                break;
            case FT.TIME:
                responses = [this.ack(t)];
                break;
            case FT.CENTRAL:
                responses = this.handleCommand(t);
                break;
            default:
                responses = t.ctrl & CTRL.BIDI ? [this.nack(t, ACK.NACK)] : [];
        }
        for (const r of responses) {
            this.log.push({at: Date.now(), dir: 'tx', frame: r.toString('hex')});
        }
        return responses;
    }

    reply(t, type, payload) {
        return encodeTelegram({
            counter: t.counter,
            ctrl: CTRL.RPT_ENABLE,
            type,
            src: this.address,
            dst: t.src,
            payload,
        });
    }

    ack(t) {
        return this.reply(t, FT.ACK_OR_NACK, [ACK.ACK]);
    }

    nack(t, code = ACK.NACK) {
        return this.reply(t, FT.ACK_OR_NACK, [code]);
    }

    /** ACK_STATUS as the XML defines it (subtype 01, channel, state, flags) plus the RSSI byte real devices append. */
    ackStatus(t, channel) {
        const frame = frameById(this.description, this.behaviour.ackStatusFrameId());
        const payload = buildFramePayload(frame, {channel, values: this.behaviour.values(channel)});
        return this.reply(t, frame.type, Buffer.concat([payload, Buffer.from([Math.abs(this.rssi) & 0xff])]));
    }

    handleCommand(t) {
        const match = matchFrame(this.description, Buffer.from(encodeTelegram(t)), 'to_device');
        if (!match) {
            // a central command the XML does not describe (e.g. FT_CENTRAL_RESET): factory reset clears the lists
            if (t.payload[0] === 0x04) {
                this.lists.clear();
                this.peers.clear();
                this.emit('reset');
                return [this.ack(t)];
            }
            return [this.nack(t, ACK.NACK)];
        }
        this.emit('command', match);
        const result = this.behaviour.command(this, match);
        if (result.kind === 'nack') {
            return [this.nack(t, ACK.NACK)];
        }
        if (result.kind === 'ack') {
            return [this.ack(t)];
        }
        return [this.ackStatus(t, match.channel ?? 1)];
    }

    handleConfig(t) {
        const p = t.payload;
        const channel = p[0];
        const subtype = p[1];
        switch (subtype) {
            case CONFIG.ENTER: {
                // broadcast with a serial: the central asks the device with that serial to announce itself
                const serial = Buffer.from(p.subarray(2, 12)).toString('ascii');
                if (serial === this.serial) {
                    return [this.sysinfoTelegram(t.src)];
                }
                return [];
            }
            case CONFIG.START: {
                this.configSession = {channel, peer: p.readUIntBE(2, 3), peerChannel: p[5], list: p[6]};
                return [this.ack(t)];
            }
            case CONFIG.WRITE_INDEX: {
                if (!this.configSession) {
                    return [this.nack(t, ACK.NACK)];
                }
                const s = this.configSession;
                const list = this.list(s.channel, s.list, s.peer, s.peerChannel);
                for (let i = 2; i + 1 < p.length; i += 2) {
                    list.set(p[i], p[i + 1]);
                }
                this.emit('config', {...s, list: s.list, values: new Map(list)});
                return [this.ack(t)];
            }
            case CONFIG.WRITE_OFFSET: {
                if (!this.configSession) {
                    return [this.nack(t, ACK.NACK)];
                }
                const s = this.configSession;
                const list = this.list(s.channel, s.list, s.peer, s.peerChannel);
                let index = p[2];
                for (let i = 3; i < p.length; i++) {
                    list.set(index++, p[i]);
                }
                return [this.ack(t)];
            }
            case CONFIG.END: {
                this.configSession = null;
                this.emit('configEnd', channel);
                return [this.ack(t)];
            }
            case CONFIG.PARAM_REQ: {
                const list = this.list(channel, p[6], p.readUIntBE(2, 3), p[5]);
                return this.paramResponses(t, list);
            }
            case CONFIG.PEER_LIST_REQ:
                return this.peerListResponses(t, channel);
            case CONFIG.PEER_ADD: {
                const peer = p.readUIntBE(2, 3);
                const set = this.peerSet(channel);
                for (const peerCh of [p[5], p[6]]) {
                    if (peerCh) {
                        set.add(`${peer}:${peerCh}`);
                    }
                }
                return [this.ack(t)];
            }
            case CONFIG.PEER_REMOVE: {
                const peer = p.readUIntBE(2, 3);
                const set = this.peerSet(channel);
                for (const peerCh of [p[5], p[6]]) {
                    set.delete(`${peer}:${peerCh}`);
                }
                return [this.ack(t)];
            }
            case CONFIG.STATUS_REQ: {
                const frame = frameById(this.description, this.behaviour.statusFrameId());
                return [
                    this.reply(
                        t,
                        frame.type,
                        buildFramePayload(frame, {channel, values: this.behaviour.values(channel)}),
                    ),
                ];
            }
            case CONFIG.SERIAL_REQ:
                return [
                    this.reply(
                        t,
                        FT.INFO,
                        Buffer.concat([Buffer.from([INFO.SERIAL]), Buffer.from(this.serial, 'ascii')]),
                    ),
                ];
            case CONFIG.CLEAR:
            case CONFIG.DETERMINE:
                return [this.ack(t)];
            default:
                return [this.nack(t, ACK.NACK)];
        }
    }

    peerSet(channel) {
        if (!this.peers.has(channel)) {
            this.peers.set(channel, new Set());
        }
        return this.peers.get(channel);
    }

    /** INFO_PARAM_RESPONSE_PAIRS frames: index/value pairs, the last frame ends with 00 00. */
    paramResponses(t, list) {
        const pairs = [...list.entries()].sort((a, b) => a[0] - b[0]).flatMap(([i, v]) => [i, v]);
        pairs.push(0x00, 0x00);
        const frames = [];
        const perFrame = Math.floor((MAX_PAYLOAD - 1) / 2) * 2;
        for (let i = 0; i < pairs.length; i += perFrame) {
            frames.push(
                this.reply(t, FT.INFO, Buffer.from([INFO.PARAM_RESPONSE_PAIRS, ...pairs.slice(i, i + perFrame)])),
            );
        }
        return frames;
    }

    /** INFO_PEER_LIST frames: address (3) and channel (1) per peer, the last frame ends with 00 00 00 00. */
    peerListResponses(t, channel) {
        const entries = [...this.peerSet(channel)].map((s) => s.split(':').map(Number));
        const bytes = [];
        for (const [address, ch] of entries) {
            bytes.push((address >> 16) & 0xff, (address >> 8) & 0xff, address & 0xff, ch & 0xff);
        }
        bytes.push(0, 0, 0, 0);
        const frames = [];
        for (let i = 0; i < bytes.length; i += 16) {
            frames.push(this.reply(t, FT.INFO, Buffer.from([INFO.PEER_LIST, ...bytes.slice(i, i + 16)])));
        }
        return frames;
    }
}
