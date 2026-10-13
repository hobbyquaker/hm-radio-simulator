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
import {challengeFrame, responseFrame, verifyResponse, signedAckFrame} from './aes.js';
import {crcOk} from './firmware.js';

const MAX_PAYLOAD = 17;

/** The frame types of a firmware update, as rfd's BidcosFrame.h names them (no rftypes frame describes them). */
export const FT_FIRMWAREUPDATE = 0xca;
export const FT_WRITE_TRX_REG = 0xcb;
/** The subtype (payload byte 0) of the CENTRAL frame that starts the bootloader: FT_CENTRAL_START_BOOTLOADER. */
export const CENTRAL_START_BOOTLOADER = 0xca;

/**
 * The bootloader of a simulated BidCoS device - **chosen** to match what rfd's own update code expects
 * (RFDevice::UpdateFirmware, BidcosInterfaceConcentrator::SendUpdataFrame, BidcosFrameStartBootloader), never read
 * from a device firmware:
 *   `startsOnCommand`  the device acknowledges CENTRAL_START_BOOTLOADER and restarts into its bootloader (else: NACK);
 *                      only a device whose type is `updatable="true"` in its description does either (`updatable`)
 *   `announces`        the bootloader announces itself with an INFO_SERIAL broadcast (receiver 000000), the frame
 *                      rfd's BidcosFrameStartBootloader waits for and RFDevice::ProcessIncomingFrame reads as
 *                      DEVICE_IN_BOOTLOADER; without it rfd goes on after its 1000 ms window on the ACK alone
 *   `ackUpdateFrames`  a complete, valid update frame is acknowledged (false: the device is as good as out of
 *                      range at 100 kbit/s - it keeps nothing and says nothing; rfd then retries three times)
 *   `checksType`       frame 0 must carry the device's type code (lib/firmware.js' synthetic layout)
 *   `checksCrc`        every frame must check to zero (the CRC-16 UpdateFile.cpp carries commented out)
 *   `failFrom`         the index of the first frame the device rejects (NACK), or null
 *   `silentFrom`       the index of the first frame the device no longer receives (it went out of range mid-way),
 *                      or null
 *   `rebootAfterMs`    how long after the last of the frames frame 0 announced the device restarts into the
 *                      application, back at 10 kbit/s and with the firmware byte frame 0 carried (chosen: rfd sends
 *                      no "done"; a device with a partial image stays in its bootloader)
 */
export const BOOTLOADER_DEFAULTS = Object.freeze({
    startsOnCommand: true,
    announces: true,
    ackUpdateFrames: true,
    checksType: true,
    checksCrc: true,
    failFrom: null,
    silentFrom: null,
    rebootAfterMs: 300,
});

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

/**
 * The remote behaviour (HM-RC-4 and its relatives, rf_rc.xml): it sends KEY_EVENT_SHORT / KEY_EVENT_LONG frames
 * (type 0x40, channel and long flag in the first payload byte, a press counter in the second) and takes no commands.
 */
export class RemoteBehaviour {
    constructor() {
        this.counter = 0;
    }

    command(device, match) {
        return match.frame.id === 'TOGGLE_INSTALL_TEST' ? {kind: 'ack'} : {kind: 'nack'};
    }

    values() {
        return {};
    }

    statusFrameId() {
        return 'KEY_EVENT_SHORT';
    }

    ackStatusFrameId() {
        return 'ACK_STATUS';
    }

    /**
     * The telegram of a key press.
     * @param {BidcosDevice} device
     * @param {number} channel the key's channel
     * @param {{long?: boolean, repeat?: boolean, bidi?: boolean}} [options] `repeat` keeps the counter (a long press
     *   repeats its frame while the key is held), `bidi` asks the central for an acknowledgement
     */
    pressTelegram(device, channel, {long = false, repeat = false, bidi = true} = {}) {
        if (!repeat) {
            this.counter = (this.counter + 1) & 0xff;
        }
        const frame = frameById(device.description, long ? 'KEY_EVENT_LONG' : 'KEY_EVENT_SHORT');
        return encodeTelegram({
            counter: device.nextCounter(),
            ctrl: CTRL.RPT_ENABLE | (bidi ? CTRL.BIDI : 0),
            type: frame.type,
            src: device.address,
            dst: device.central ?? BROADCAST,
            payload: buildFramePayload(frame, {channel, values: {COUNTER: this.counter, TEST_COUNTER: this.counter}}),
        });
    }
}

export class BidcosDevice extends EventEmitter {
    /**
     * @param {{address: number, serial: string, description: object, typeId: string, behaviour?: object,
     *   firmware?: number, rssi?: number, answering?: boolean, peeringChannel?: number, channelCount?: number,
     *   aes?: boolean, aesKeyIndex?: number, aesKey?: Buffer|null, rxMode?: 'always'|'config'|'wakeup'|'burst',
     *   listenAfterSendMs?: number, awakeMs?: number, configModeMs?: number}} options
     *   `channelCount` is what a `count_from_sysinfo="23.0:1.0"` channel type reads from the announcement; with
     *   `aes` the device answers commands with the AES challenge and acknowledges only a correct response, using
     *   `aesKey` or, when that is null, the key the central gave the module for `aesKeyIndex` (the air provides it).
     *   `rxMode` is when the device's receiver is on (the XML's `rx_modes`; all values chosen, not measured):
     *   'always' (mains-powered, the default); 'config' and 'wakeup' (battery devices that sleep: they listen for
     *   `listenAfterSendMs` (300 ms) after each of their own telegrams - long enough for the central's ACK or the
     *   module's WAKEUP - and `awakeMs` (1000 ms) after the module woke them or after any telegram they received while
     *   awake); 'burst' (a device that samples the air every ~300 ms: a burst telegram, with its 360 ms preamble, wakes
     *   it, and it then stays awake for `awakeMs`, 2000 ms by default - rfd assumes 1800 ms, BURST_ACTIVE_INTERVAL).
     *   The config button (`announce`) puts a sleeping device into config mode for `configModeMs` (15 s).
     *   `bootloader` are the firmware-update knobs (BOOTLOADER_DEFAULTS).
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
        aes = false,
        aesKeyIndex = 1,
        aesKey = null,
        rxMode = 'always',
        listenAfterSendMs = 300,
        awakeMs = null,
        configModeMs = 15000,
        bootloader = {},
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
        this.aes = aes;
        this.aesKeyIndex = aesKeyIndex;
        this.aesKey = aesKey;
        this.rxMode = rxMode;
        this.listenAfterSendMs = listenAfterSendMs;
        this.awakeMs = awakeMs ?? (rxMode === 'burst' ? 2000 : 1000);
        this.configModeMs = configModeMs;
        /** Until when (Date.now() ms) a sleeping device's receiver is on. */
        this.awakeUntil = 0;
        /** @type {(index: number) => Buffer|null} the central's key table, set by the air */
        this.keyProvider = () => null;
        /** @type {() => number|null} the central's current key index, set by the air (the exchange's target) */
        this.keyIndexProvider = () => null;
        /** @type {{m: object, challenge: Buffer}|null} the command waiting for the central's AES response */
        this.pendingAes = null;
        this.aesFailures = 0;
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
        this.bootloader = {...BOOTLOADER_DEFAULTS, ...bootloader};
        /**
         * Whether the type's description says `updatable="true"`: only such a device enters its bootloader on
         * CENTRAL_START_BOOTLOADER; another type acknowledges the frame (its XML's ENTER_BOOTLOADER, if any) and keeps
         * running - chosen, so that the frame stays a plain command for the devices rfd would not update.
         */
        const type = description.types.find((x) => x.id === typeId);
        this.updatable = Boolean(type && type.updatable);
        /** @type {'app'|'bootloader'} */
        this.mode = 'app';
        /** The radio's data rate in kbit/s; the bootloader goes to 100 on WRITE_TRX_REG, the application runs at 10. */
        this.dataRate = 10;
        /** @type {Buffer[]} the complete update frames the bootloader accepted (length bytes included), in order */
        this.updateFrames = [];
        /** @type {Array<{index: number, reason: string}>} the frames it rejected */
        this.rejectedFrames = [];
        /** @type {Buffer|null} the chunks of the frame in transfer */
        this.chunk = null;
        /** The firmware byte the update carried (frame 0), applied when the device restarts. */
        this.firmwareFromUpdate = null;
        /** How many frames the update has (frame 0), or null before it. */
        this.expectedFrames = null;
        this.rebootTimer = null;
    }

    nextCounter() {
        this.counter = (this.counter + 1) & 0xff;
        return this.counter;
    }

    // -----------------------------------------------------------------------------------------------------------
    // the receiver: always on, or asleep between windows

    /** Whether the device's receiver is off most of the time (any rx mode but 'always'). */
    get sleeps() {
        return this.rxMode !== 'always';
    }

    /** Whether the device is awake right now (always true for a mains-powered device). */
    get awake() {
        return !this.sleeps || Date.now() < this.awakeUntil;
    }

    /**
     * Whether a telegram reaches the device: it is there (`answering`) and its receiver is on - always, inside a
     * window, or (rx mode 'burst') woken by a burst telegram's preamble.
     * @param {{burst?: boolean}} [options]
     */
    hears({burst = false} = {}) {
        if (!this.answering) {
            return false;
        }
        return this.awake || (this.rxMode === 'burst' && burst);
    }

    /** Keeps the receiver on for `ms` from now (never shortens a longer window). */
    wake(ms = this.awakeMs) {
        this.awakeUntil = Math.max(this.awakeUntil, Date.now() + ms);
    }

    /** Puts a sleeping device to sleep at once (the test's way of saying "it went back to sleep"). */
    sleep() {
        this.awakeUntil = 0;
    }

    /** The device transmitted on its own: its receiver stays on for the answer. */
    transmitted() {
        if (this.sleeps) {
            this.wake(this.listenAfterSendMs);
        }
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
        if (this.sleeps) {
            // a telegram that reached the device keeps it awake a while longer (a burst woke it, or it was awake)
            this.wake();
        }
        if (t.dst === this.address && this.central === null && t.src !== 0) {
            this.central = t.src;
        }
        let responses;
        if (this.mode === 'bootloader') {
            responses = this.handleBootloader(t);
            for (const r of responses) {
                this.log.push({at: Date.now(), dir: 'tx', frame: r.toString('hex')});
            }
            return responses;
        }
        if (t.type === FT.CENTRAL && t.payload[0] === CENTRAL_START_BOOTLOADER && this.updatable) {
            responses = this.handleStartBootloader(t);
            for (const r of responses) {
                this.log.push({at: Date.now(), dir: 'tx', frame: r.toString('hex')});
            }
            return responses;
        }
        switch (t.type) {
            case FT.CONFIG:
                responses = this.handleConfig(t);
                break;
            case FT.ACK_OR_NACK:
                responses = []; // an ACK of our own status report
                break;
            case FT.AES_CONTAINER: {
                // the key exchange (two frames, each carrying half of the new key encrypted with the old one): the
                // simulated device accepts both and switches to the new key index with the second part; the key
                // itself it takes from the central's table (the air's keyProvider), so no key material is decrypted
                // (the frame's index bits name the key the device holds now; the new index travels inside the
                // encrypted key material, which the simulation does not decrypt - the central's current index is it)
                const part = t.payload[1] & 0x01;
                if (part === 1) {
                    const index = this.keyIndexProvider();
                    if (index !== null) {
                        this.aesKeyIndex = index;
                    }
                    this.emit('keyChanged', this.aesKeyIndex);
                }
                responses = [this.ack(t)];
                break;
            }
            case FT.TIME:
                responses = [this.ack(t)];
                break;
            case FT.WAKEUP:
                // the module's wake-up after the device's own telegram (sent when rfd asked the module to wake the
                // device): the receiver stays on for awakeMs
                this.wake();
                this.emit('wokenUp');
                responses = t.ctrl & CTRL.BIDI ? [this.ack(t)] : [];
                break;
            case FT.CENTRAL:
                if (this.aes) {
                    // an AES-secured device answers a command with the challenge; the command waits for the response
                    const {telegram, challenge} = challengeFrame(t, this.aesKeyIndex);
                    this.pendingAes = {m: t, challenge};
                    responses = [telegram];
                } else {
                    responses = this.handleCommand(t);
                }
                break;
            case FT.AES_SOLUTION:
                responses = this.handleAesResponse(t);
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

    // -----------------------------------------------------------------------------------------------------------
    // the bootloader (a firmware update; see BOOTLOADER_DEFAULTS)

    /** The bootloader's announcement: INFO_SERIAL (10 00 + serial) to receiver 000000. */
    infoSerialTelegram() {
        return encodeTelegram({
            counter: this.nextCounter(),
            ctrl: CTRL.RPT_ENABLE | CTRL.BCAST,
            type: FT.INFO,
            src: this.address,
            dst: BROADCAST,
            payload: Buffer.concat([Buffer.from([INFO.SERIAL]), Buffer.from(this.serial, 'ascii')]),
        });
    }

    /** CENTRAL_START_BOOTLOADER in the application: the ACK, the restart into the bootloader, its announcement. */
    handleStartBootloader(t) {
        if (!this.bootloader.startsOnCommand) {
            return [this.nack(t, ACK.NACK)];
        }
        this.enterBootloader();
        const responses = [this.ack(t)];
        if (this.bootloader.announces) {
            responses.push(this.infoSerialTelegram());
        }
        return responses;
    }

    enterBootloader() {
        clearTimeout(this.rebootTimer);
        this.rebootTimer = null;
        this.mode = 'bootloader';
        this.dataRate = 10;
        this.chunk = null;
        this.updateFrames = [];
        this.rejectedFrames = [];
        this.expectedFrames = null;
        this.emit('mode', 'bootloader');
    }

    /** The restart into the application after the update: 10 kbit/s, the new firmware byte. */
    leaveBootloader() {
        clearTimeout(this.rebootTimer);
        this.rebootTimer = null;
        this.mode = 'app';
        this.dataRate = 10;
        this.chunk = null;
        if (this.firmwareFromUpdate !== null) {
            this.firmware = this.firmwareFromUpdate;
            this.firmwareFromUpdate = null;
        }
        this.emit('mode', 'app');
    }

    /**
     * What the bootloader answers: WRITE_TRX_REG switches the radio to 100 kbit/s, FIRMWAREUPDATE chunks are collected
     * until the one with BIDI closes the frame, everything else is refused.
     */
    handleBootloader(t) {
        const bidi = (t.ctrl & CTRL.BIDI) !== 0;
        if (t.type === FT.CENTRAL && t.payload[0] === CENTRAL_START_BOOTLOADER) {
            // started again while already in the bootloader (rfd skips the frame when it knows, but a restart of
            // rfd forgets): the same answer as from the application
            return this.handleStartBootloader(t);
        }
        if (t.type === FT_WRITE_TRX_REG) {
            // the register values are the transceiver's 100 kbit/s settings; the simulation does not interpret them
            this.dataRate = 100;
            this.emit('dataRate', 100);
            return bidi ? [this.ack(t)] : [];
        }
        if (t.type === FT_FIRMWAREUPDATE) {
            this.chunk = this.chunk ? Buffer.concat([this.chunk, t.payload]) : Buffer.from(t.payload);
            if (!bidi) {
                return [];
            }
            const frame = this.chunk;
            this.chunk = null;
            const index = this.updateFrames.length;
            const reason = this.checkUpdateFrame(frame, index);
            if (reason) {
                this.rejectedFrames.push({index, reason});
                this.emit('updateFrameRejected', {index, reason, frame});
                return [this.nack(t, ACK.NACK)];
            }
            const silent =
                !this.bootloader.ackUpdateFrames ||
                (this.bootloader.silentFrom !== null && index >= this.bootloader.silentFrom);
            if (silent) {
                // out of range: the frame did not arrive, nothing is kept, no restart
                this.emit('updateFrameLost', {index, frame});
                return [];
            }
            this.updateFrames.push(frame);
            if (index === 0) {
                this.firmwareFromUpdate = frame[4];
                this.expectedFrames = frame[5];
            }
            this.emit('updateFrame', {index, frame});
            if (this.expectedFrames !== null && this.updateFrames.length >= this.expectedFrames) {
                clearTimeout(this.rebootTimer);
                this.rebootTimer = setTimeout(() => this.leaveBootloader(), this.bootloader.rebootAfterMs);
            }
            return [this.ack(t)];
        }
        return bidi ? [this.nack(t, ACK.NACK)] : [];
    }

    /** Why the bootloader refuses a frame, or null when it takes it. */
    checkUpdateFrame(frame, index) {
        if (frame.length < 4 || frame.readUInt16BE(0) !== frame.length - 2) {
            return 'length';
        }
        if (this.bootloader.checksCrc && !crcOk(frame.subarray(2))) {
            return 'crc';
        }
        if (this.bootloader.checksType && index === 0 && frame.readUInt16BE(2) !== this.typeCode) {
            return 'type';
        }
        if (this.bootloader.failFrom !== null && index >= this.bootloader.failFrom) {
            return 'refused';
        }
        return null;
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

    /**
     * The other direction: the device sent an event and the central challenges it. The device answers with the
     * R frame computed from its key; the central verifies and acknowledges with the signature.
     * @param {object} m the decoded event telegram the device sent
     * @param {Uint8Array} challenge the six challenge bytes
     * @returns {Buffer|null} the R frame, or null without a key
     */
    answerChallenge(m, challenge) {
        const key = this.aesKey || this.keyProvider(this.aesKeyIndex);
        if (!key) {
            return null;
        }
        return responseFrame(key, challenge, m).telegram;
    }

    /** The central's R frame: verified against the pending command; a match executes it and signs the ACK. */
    handleAesResponse(t) {
        const pending = this.pendingAes;
        this.pendingAes = null;
        if (!pending) {
            return [];
        }
        const key = this.aesKey || this.keyProvider(this.aesKeyIndex);
        const check = key ? verifyResponse(key, pending.challenge, pending.m, t.payload) : {ok: false};
        if (!check.ok) {
            this.aesFailures++;
            this.emit('aesFailure', pending.m);
            return []; // a real device stays silent on a wrong response
        }
        this.handleCommand(pending.m); // the command takes effect; its own ACK is replaced by the signed one
        this.emit('aesSuccess', pending.m);
        return [signedAckFrame(pending.m, check.pd)];
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
