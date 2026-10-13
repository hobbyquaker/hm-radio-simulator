/**
 * The simulated BidCoS radio module: the state machine behind the serial framing that answers rfd's coprocessor
 * commands. It is transport-agnostic - attach any duplex stream (the TCP end of a socat pty, a TCP socket of the
 * LAN-gateway front, a PassThrough pair in a unit test).
 *
 * What it models: the identify handshake (application or bootloader), versions, serial number, clock, the RF address,
 * AES key slots, the link-peer table, authentication flags, duty cycle, and SEND_TELEGRAM with a pluggable "air"
 * that decides the status (sent, acknowledged, failed). What it does not model: the radio itself. Timing on the air
 * is a status code plus a delay here, never a bit on a wire; the daemon only ever sees status codes anyway.
 *
 * Every delay the module uses is a declared default (see DEFAULTS) - chosen, not measured, unless the README says
 * otherwise.
 */

import {EventEmitter} from 'node:events';
import {
    TYPE,
    SYSTEM,
    SYSTEM_STATUS,
    BIDCOS,
    BIDCOS_STATUS,
    EVENT_AUTH,
    EVENT_FLAG_WOKEN_UP,
    IDENTIFY_APP,
    IDENTIFY_BOOTLOADER,
    commandName,
} from './commands.js';
import {FrameParser, encodeFrame} from './frame.js';
import {decodeTelegram, encodeTelegram, CTRL, FT, ACK} from './telegram.js';

export {decodeTelegram, encodeTelegram};

export const DEFAULTS = Object.freeze({
    serial: 'SIM0000001',
    firmwareVersion: [2, 8, 6],
    bootloaderVersion: [1, 0, 12],
    mode: 'app', // or 'bootloader'
    defaultRfAddress: 0x1a2b3c,
    /** Milliseconds between a command and its response (measured 2026-10-11 on an RPI-RF-MOD through multimacd: 0.2-0.6 ms). */
    responseDelayMs: 1,
    /** Milliseconds after STARTBOOTLOADER until the module announces the new mode with an identify event. */
    modeSwitchDelayMs: 300,
    /**
     * Whether STARTBOOTLOADER gets a RESPONSE_STATUS OK before the module restarts. Chosen default: yes. rfd's
     * improvedInit() needs the response to leave the bootloader - its fallback (the identify event after 2.5 s)
     * cannot fire, because the event handler only try-locks the coprocessor-state mutex that improvedInit() holds
     * while it waits. hmlangw, which expects the identify announcement as the first frame after its enter-bootloader
     * command, retries past the response. After the restart the module announces itself with counter 0 (the frame
     * hmlangw compares against) and ignores a STARTBOOTLOADER that arrives while it is restarting.
     */
    startBootloaderAcknowledged: true,
    /** Milliseconds until a telegram nobody answers is reported as TELEGRAM_SENT (chosen; rfd allows 4000). */
    sendDelayMs: 30,
    /**
     * Milliseconds until an acknowledged telegram is reported: measured 2026-10-11 on an RPI-RF-MOD (through multimacd)
     * with an HM-LC-Sw1-Pl-2 - "Telegram sent, received ACK" 155 ms after rfd wrote a switch command, twice.
     */
    ackDelayMs: 155,
    /**
     * Milliseconds until an unanswered telegram to a known peer is reported as SEND_FAILED: measured 2026-10-11 on an
     * RPI-RF-MOD (through multimacd) with the switch unplugged - "Telegram send failed" 1105.5 and 1106.0 ms after rfd
     * wrote the switch command (the acknowledged send next to it: 155 ms). rfd waits 4000 ms.
     */
    failDelayMs: 1106,
    /**
     * Milliseconds until a send the device answers with its AES challenge is reported as AUTHENTICATION_SUCCESS (the
     * module answers the challenge and checks the signed ACK itself): measured 2026-10-11 on an RPI-RF-MOD during a
     * pairing - 405-428 ms after rfd wrote the frame (AES_CONTAINER and CONFIG_* frames); the plain ACKs of the same
     * pairing came after 149-150 ms.
     */
    authDelayMs: 415,
    /** Duty cycle in percent as GETDUTYCYCLE reports it. */
    dutyCycle: 0,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The RSSI byte of a send-status frame (TELEGRAM_SENT_RECVD_ACK, AUTHENTICATION_SUCCESS). **Measured** 2026-10-11 on
 * an RPI-RF-MOD: the status frames carry the RSSI of the device's acknowledgement as a signed byte (`d8` = -40 dBm),
 * while the event frames carry its magnitude (`28` = 40). rfd negates both like the magnitude, so the ACK's RSSI comes
 * out as -216 on ARM and +40 on x86_64 (the `ack-rssi-sign` finding, upstream-reports/020-ack-rssi-signed.md).
 * @param {number} rssi in dBm (negative)
 */
export function statusRssiByte(rssi) {
    return rssi & 0xff;
}

export class RadioModule extends EventEmitter {
    /**
     * @param {Partial<typeof DEFAULTS> & {air?: (telegram: object, module: RadioModule) => Promise<{status: number, data?: Uint8Array}>}} [options]
     */
    constructor(options = {}) {
        super();
        this.options = {...DEFAULTS, ...options};
        this.serial = this.options.serial;
        this.mode = this.options.mode;
        this.firmwareVersion = [...this.options.firmwareVersion];
        this.bootloaderVersion = [...this.options.bootloaderVersion];
        this.defaultRfAddress = this.options.defaultRfAddress;
        this.dutyCycle = this.options.dutyCycle;
        /** The radio's data rate in kbit/s: 10, or 100 after SET_100K_DATARATE (a firmware update). */
        this.dataRate = 10;
        /** @type {number|null} the address rfd set, or null */
        this.rfAddress = null;
        /** @type {{utcSeconds: number, offsetHalfHours: number}|null} */
        this.clock = null;
        this.csmaca = null;
        this.dutyCycleCheck = null;
        /** @type {Map<string, Buffer>} key slot -> raw data as rfd sent it */
        this.aesKeys = new Map();
        /** @type {Map<number, Buffer>} key index -> the 16-byte key (SET_CURRENT_AES_KEY and the others carry key + index) */
        this.keyTable = new Map();
        /** @type {Map<number, Buffer>} peer address -> raw data of ADD_LINK_PEER */
        this.peers = new Map();
        /**
         * @type {Map<number, {channels: Set<number>, raw: Buffer}>} address -> the channels under authentication:
         * AUTHENTICATION_ON adds its channel list, AUTHENTICATION_OFF removes its list (rfd sends both: the active
         * channels on, the others off)
         */
        this.authentication = new Map();
        /** The index of the last SET_CURRENT_AES_KEY: what a device switches to after a key exchange. */
        this.currentKeyIndex = 0;
        /** @type {Array<{at: number, type: number, counter: number, command: number, name: string, data: Buffer}>} */
        this.commands = [];
        /** @type {Array<{at: number, bytes: Buffer}>} */
        this.sent = [];
        this.eventCounter = 0;
        this.parser = new FrameParser();
        this.stream = null;
        this.air = this.options.air || RadioModule.defaultAir;
        /** @type {Map<string, Array<{status?: number, drop?: boolean, delayMs?: number}>>} */
        this.faults = new Map();
        // faults present from the first command on (`faults: {SET_CLOCK: {status: 0x02, times: 10}}`), for the start
        for (const [name, fault] of Object.entries(this.options.faults || {})) {
            this.inject(name, fault);
        }
        this.stats = {framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, crcErrors: 0};
        this.closed = false;
    }

    /** Default air: nobody answers, so every telegram is "sent" after sendDelayMs. */
    static async defaultAir(telegram, module) {
        await sleep(module.options.sendDelayMs);
        return {status: BIDCOS_STATUS.TELEGRAM_SENT};
    }

    /**
     * Connects the module to a duplex byte stream. Bytes from the stream are parsed as frames; responses and events
     * are written back. Attaching a second stream replaces the first (the module came back on a new line).
     * @param {import('node:stream').Duplex} stream
     */
    attach(stream) {
        this.detach();
        this.stream = stream;
        this.parser = new FrameParser();
        this._onData = (chunk) => this.receive(chunk);
        this._onClose = () => {
            if (this.stream === stream) {
                this.stream = null;
                this.emit('detached');
            }
        };
        stream.on('data', this._onData);
        stream.on('close', this._onClose);
        stream.on('error', () => {});
        this.emit('attached');
    }

    detach() {
        if (this.stream) {
            this.stream.off('data', this._onData);
            this.stream.off('close', this._onClose);
            this.stream = null;
            this.emit('detached');
        }
    }

    get attached() {
        return this.stream !== null;
    }

    /**
     * Feeds raw bytes as they come from the daemon.
     * @param {Uint8Array} chunk
     */
    receive(chunk) {
        this.stats.bytesIn += chunk.length;
        for (const result of this.parser.push(chunk)) {
            if (result.error) {
                if (result.error === 'crc') {
                    this.stats.crcErrors++;
                }
                this.emit('frameError', result);
                continue;
            }
            this.stats.framesIn++;
            this.handleFrame(result.payload);
        }
    }

    /**
     * Writes raw bytes to the attached stream (frames or deliberate garbage).
     * @param {Uint8Array} bytes
     * @returns {boolean} false when nothing is attached
     */
    writeRaw(bytes) {
        if (!this.stream || this.stream.destroyed || this.closed) {
            return false;
        }
        const buffer = Buffer.from(bytes);
        this.stats.bytesOut += buffer.length;
        this.sent.push({at: Date.now(), bytes: buffer});
        this.stream.write(buffer);
        return true;
    }

    /**
     * @param {Uint8Array} payload
     */
    writeFrame(payload) {
        this.stats.framesOut++;
        this.emit('frameOut', Buffer.from(payload));
        return this.writeRaw(encodeFrame(payload));
    }

    /**
     * Registers a fault for a command: {status} answers with that status instead, {drop: true} answers nothing,
     * {delayMs} delays the answer. `times` consumes the fault that many times (default 1).
     * @param {string} name a command name, e.g. 'GET_SERIALNR'
     * @param {{status?: number, drop?: boolean, delayMs?: number, times?: number}} fault
     */
    inject(name, fault) {
        const list = this.faults.get(name) || [];
        for (let i = 0; i < (fault.times ?? 1); i++) {
            list.push(fault);
        }
        this.faults.set(name, list);
    }

    /**
     * Resolves when the module has seen `count` commands of that name (counting from the start of the log).
     * @param {string} name
     * @param {{timeout?: number, count?: number}} [options]
     * @returns {Promise<object>} the matching command record
     */
    waitForCommand(name, {timeout = 5000, count = 1} = {}) {
        const matching = () => this.commands.filter((c) => c.name === name);
        if (matching().length >= count) {
            return Promise.resolve(matching()[count - 1]);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.off('command', onCommand);
                reject(
                    new Error(
                        `timeout waiting for ${name} (${count}); seen: ${this.commands.map((c) => c.name).join(' ')}`,
                    ),
                );
            }, timeout);
            const onCommand = () => {
                const found = matching();
                if (found.length >= count) {
                    clearTimeout(timer);
                    this.off('command', onCommand);
                    resolve(found[count - 1]);
                }
            };
            this.on('command', onCommand);
        });
    }

    /** @param {Uint8Array} payload */
    handleFrame(payload) {
        if (payload.length < 3) {
            this.emit('frameError', {error: 'short', raw: Buffer.from(payload)});
            return;
        }
        const type = payload[0];
        const counter = payload[1];
        const command = payload[2];
        const data = Buffer.from(payload.subarray(3));
        const record = {at: Date.now(), type, counter, command, name: commandName(type, command), data};
        this.commands.push(record);
        this.emit('command', record);

        const fault = this.takeFault(record.name);
        if (fault && fault.drop) {
            return;
        }
        // answers after the declared delay; resolves once the frame is written, so what must follow the answer (the
        // air's further event frames) can be ordered behind it
        const respond = (status, responseData) => {
            if (fault && fault.status !== undefined) {
                status = fault.status;
                responseData = undefined;
            }
            const delay = (fault && fault.delayMs) ?? this.options.responseDelayMs;
            const frame =
                type === TYPE.SYSTEM
                    ? this.systemResponse(counter, status, responseData)
                    : this.bidcosResponse(counter, status, responseData);
            return new Promise((resolve) => {
                setTimeout(() => {
                    this.writeFrame(frame);
                    resolve();
                }, delay);
            });
        };

        if (type === TYPE.SYSTEM) {
            this.handleSystem(command, data, respond);
        } else if (type === TYPE.BIDCOS) {
            this.handleBidcos(record, respond);
        } else {
            this.emit('frameError', {error: 'type', raw: Buffer.from(payload)});
        }
    }

    /**
     * The device's authentication channel mask as the firmware reports it in the ADD_LINK_PEER answer: 8 bytes,
     * big-endian, bit n set = channel n is NOT under authentication.
     * @param {number} address
     */
    authenticationMask(address) {
        const mask = Buffer.alloc(8, 0xff);
        const policy = this.authentication.get(address);
        if (policy) {
            for (const channel of policy.channels) {
                if (channel < 64) {
                    mask[7 - (channel >> 3)] &= ~(1 << (channel & 7));
                }
            }
        }
        return mask;
    }

    /**
     * rfd's wake-up request for a device, from the last ADD_LINK_PEER for it: address (3), key index, wake-up flag,
     * lazy-config flag (CCU2BidcosRemoteInterface::AddDeviceRemote). rfd re-sends ADD_LINK_PEER to set and to clear the
     * request (AddDeviceWakeupRequest / RemoveDeviceWakeupRequest).
     * @param {number} address
     * @returns {{lazy: boolean}|null} null when no wake-up is requested
     */
    wakeupRequest(address) {
        const data = this.peers.get(address);
        if (!data || data.length < 5 || data[4] !== 0x01) {
            return null;
        }
        return {lazy: data.length >= 6 && data[5] === 0x01};
    }

    takeFault(name) {
        const list = this.faults.get(name);
        if (!list || list.length === 0) {
            return null;
        }
        return list.shift();
    }

    systemResponse(counter, status, data) {
        return Buffer.concat([
            Buffer.from([TYPE.SYSTEM, counter, SYSTEM.RESPONSE_STATUS, status]),
            Buffer.from(data || []),
        ]);
    }

    bidcosResponse(counter, status, data) {
        const head = Buffer.from([TYPE.BIDCOS, counter, BIDCOS.STATUS, status]);
        if (status === BIDCOS_STATUS.DATA) {
            // fragment number, fragment count, data
            return Buffer.concat([head, Buffer.from([0x00, 0x01]), Buffer.from(data || [])]);
        }
        return Buffer.concat([head, Buffer.from(data || [])]);
    }

    handleSystem(command, data, respond) {
        switch (command) {
            case SYSTEM.IDENTIFY:
                respond(SYSTEM_STATUS.DATA, Buffer.from(this.mode === 'app' ? IDENTIFY_APP : IDENTIFY_BOOTLOADER));
                return;
            case SYSTEM.GETVERSION:
                respond(SYSTEM_STATUS.DATA, Buffer.from([...this.bootloaderVersion, ...this.firmwareVersion]));
                return;
            case SYSTEM.STARTBOOTLOADER:
                // From the bootloader this starts the application; from the application it enters the bootloader.
                // A command during the restart is lost, as with a module that is rebooting.
                if (this.modeSwitchTimer) {
                    return;
                }
                if (this.options.startBootloaderAcknowledged) {
                    respond(SYSTEM_STATUS.OK);
                }
                this.switchMode(this.mode === 'app' ? 'bootloader' : 'app');
                return;
            case SYSTEM.GET_SERIALNR:
                respond(SYSTEM_STATUS.DATA, Buffer.from(this.serial, 'ascii'));
                return;
            case SYSTEM.SET_CLOCK:
                if (data.length >= 5) {
                    this.clock = {utcSeconds: data.readUInt32BE(0), offsetHalfHours: data.readInt8(4)};
                    respond(SYSTEM_STATUS.OK);
                } else {
                    respond(SYSTEM_STATUS.INPUT_ERROR);
                }
                return;
            case SYSTEM.CSMACA_ON_OFF:
                this.csmaca = data[0] === 1;
                respond(SYSTEM_STATUS.OK);
                return;
            case SYSTEM.DUTYCYCLE_ON_OFF:
                this.dutyCycleCheck = data[0] === 1;
                respond(SYSTEM_STATUS.OK);
                return;
            case SYSTEM.GETDUTYCYCLE:
                respond(SYSTEM_STATUS.DATA, Buffer.from([Math.round(this.dutyCycle * 2) & 0xff]));
                return;
            case SYSTEM.SET_10K_DATARATE:
            case SYSTEM.SET_100K_DATARATE:
                // the radio's data rate: 10 kbit/s normally, 100 kbit/s for a firmware update (rfd switches the
                // device with WRITE_TRX_REG first, then the module); the air delivers only between a module and a
                // device at the same rate
                this.dataRate = command === SYSTEM.SET_100K_DATARATE ? 100 : 10;
                this.emit('dataRate', this.dataRate);
                respond(SYSTEM_STATUS.OK);
                return;
            default:
                respond(SYSTEM_STATUS.ERROR);
        }
    }

    handleBidcos(record, respond) {
        const {command, data} = record;
        if (this.mode !== 'app') {
            respond(BIDCOS_STATUS.NOT_INITIALIZED);
            return;
        }
        switch (command) {
            case BIDCOS.SET_RF_ADDRESS:
                if (data.length >= 3) {
                    this.rfAddress = data.readUIntBE(0, 3);
                    respond(BIDCOS_STATUS.OK);
                } else {
                    respond(BIDCOS_STATUS.INPUT_WRONG);
                }
                return;
            case BIDCOS.GET_RF_ADDRESS:
                if (this.rfAddress === null) {
                    respond(BIDCOS_STATUS.NOT_INITIALIZED);
                } else {
                    respond(BIDCOS_STATUS.DATA, address3(this.rfAddress));
                }
                return;
            case BIDCOS.GET_DEFAULT_RF_ADDRESS:
                respond(BIDCOS_STATUS.DATA, address3(this.defaultRfAddress));
                return;
            case BIDCOS.SET_CURRENT_AES_KEY:
            case BIDCOS.SET_PREVIOUS_KEY:
            case BIDCOS.SET_TEMP_AES_KEY:
                this.aesKeys.set(record.name, data);
                if (data.length >= 17) {
                    this.keyTable.set(data[16], Buffer.from(data.subarray(0, 16)));
                    if (command === BIDCOS.SET_CURRENT_AES_KEY) {
                        this.currentKeyIndex = data[16];
                    }
                }
                respond(BIDCOS_STATUS.OK);
                return;
            case BIDCOS.ADD_LINK_PEER:
                if (data.length >= 3) {
                    // the firmware answers with the number of link peers (2 bytes) and the device's authentication
                    // channel mask (8 bytes, big-endian, a set bit = authentication OFF); rfd compares the mask with
                    // its own and sends AUTHENTICATION_ON/OFF only for the channels that differ (so a device whose
                    // channels need no AES gets no AUTHENTICATION command at all)
                    const address = data.readUIntBE(0, 3);
                    this.peers.set(address, data);
                    const reply = Buffer.alloc(10);
                    reply.writeUInt16BE(this.peers.size, 0);
                    this.authenticationMask(address).copy(reply, 2);
                    respond(BIDCOS_STATUS.DATA, reply);
                } else {
                    respond(BIDCOS_STATUS.INPUT_WRONG);
                }
                return;
            case BIDCOS.REMOVE_LINK_PEER:
                if (data.length >= 3) {
                    this.peers.delete(data.readUIntBE(0, 3));
                    respond(BIDCOS_STATUS.OK);
                } else {
                    respond(BIDCOS_STATUS.INPUT_WRONG);
                }
                return;
            case BIDCOS.GET_LINK_PEERS:
                respond(BIDCOS_STATUS.DATA, Buffer.concat([...this.peers.keys()].map(address3)));
                return;
            case BIDCOS.AUTHENTICATION_ON:
            case BIDCOS.AUTHENTICATION_OFF:
                if (data.length >= 3) {
                    const address = data.readUIntBE(0, 3);
                    const policy = this.authentication.get(address) || {channels: new Set(), raw: data};
                    for (const channel of data.subarray(3)) {
                        if (command === BIDCOS.AUTHENTICATION_ON) {
                            policy.channels.add(channel);
                        } else {
                            policy.channels.delete(channel);
                        }
                    }
                    policy.raw = data;
                    this.authentication.set(address, policy);
                    respond(BIDCOS_STATUS.OK);
                } else {
                    respond(BIDCOS_STATUS.INPUT_WRONG);
                }
                return;
            case BIDCOS.SET_PEER_KEY_INDEX:
                respond(BIDCOS_STATUS.OK);
                return;
            case BIDCOS.GET_PEER_KEY_INDEX:
                respond(BIDCOS_STATUS.DATA, Buffer.from([0x00]));
                return;
            case BIDCOS.GET_KEY_CHECKSUM:
                respond(BIDCOS_STATUS.DATA, Buffer.from([0x00, 0x00]));
                return;
            case BIDCOS.SEND_TELEGRAM:
                this.handleSendTelegram(record, respond);
                return;
            default:
                respond(BIDCOS_STATUS.INPUT_WRONG);
        }
    }

    handleSendTelegram(record, respond) {
        const {data} = record;
        // two bytes "time to wait before sending", one byte burst mode, then the telegram (no length byte)
        if (data.length < 3 + 9) {
            respond(BIDCOS_STATUS.INPUT_WRONG);
            return;
        }
        const telegram = decodeTelegram(data.subarray(3));
        const request = {
            waitMs: data.readUInt16BE(0),
            burst: data[2],
            telegram,
            raw: Buffer.from(data.subarray(3)),
        };
        this.emit('telegram', request);
        Promise.resolve(this.air(request, this))
            .then(async (result) => {
                await respond(result.status, result.data);
                this.emit('telegramResult', {request, result});
            })
            .catch((error) => {
                this.emit('error', error);
                respond(BIDCOS_STATUS.ERROR);
            });
    }

    /**
     * Enters the other mode after the declared delay and announces it with an identify event, as the module does
     * after a reset or a bootloader command. The restart resets the event counter: the announcement carries counter 0.
     * @param {'app'|'bootloader'} mode
     */
    switchMode(mode) {
        clearTimeout(this.modeSwitchTimer);
        this.modeSwitchTimer = setTimeout(() => {
            this.modeSwitchTimer = null;
            this.mode = mode;
            this.eventCounter = 0;
            this.emit('mode', mode);
            this.sendIdentifyEvent(0);
        }, this.options.modeSwitchDelayMs);
    }

    nextEventCounter() {
        this.eventCounter = (this.eventCounter + 1) & 0xff;
        return this.eventCounter;
    }

    /**
     * The unsolicited identify frame the module sends when it (re)starts.
     * @param {number} [counter] the frame counter; a restarted module announces itself with 0
     */
    sendIdentifyEvent(counter = this.nextEventCounter()) {
        const text = this.mode === 'app' ? IDENTIFY_APP : IDENTIFY_BOOTLOADER;
        return this.writeFrame(
            Buffer.concat([Buffer.from([TYPE.SYSTEM, counter & 0xff, SYSTEM.IDENTIFY]), Buffer.from(text)]),
        );
    }

    /**
     * @param {number} percent 0..100
     */
    sendDutyCycleEvent(percent) {
        this.dutyCycle = percent;
        return this.writeFrame(
            Buffer.from([TYPE.SYSTEM, this.nextEventCounter(), SYSTEM.EVENT_DUTYCYCLE, Math.round(percent * 2) & 0xff]),
        );
    }

    /**
     * A received BidCoS telegram, as the module reports it to the daemon: flags, key index, RSSI, the telegram.
     * @param {Uint8Array|object} telegram raw telegram bytes (no length byte) or an object for encodeTelegram()
     * @param {{rssi?: number, auth?: number, keyIndex?: number, wokenUp?: boolean}} [options]
     */
    sendEvent(telegram, {rssi = -60, auth = EVENT_AUTH.NO_AUTH_REQUIRED, keyIndex = 0, wokenUp = false} = {}) {
        const bytes = telegram instanceof Uint8Array ? Buffer.from(telegram) : encodeTelegram(telegram);
        const flags = (auth & 0x07) | (wokenUp ? EVENT_FLAG_WOKEN_UP : 0);
        return this.writeFrame(
            Buffer.concat([
                Buffer.from([
                    TYPE.BIDCOS,
                    this.nextEventCounter(),
                    BIDCOS.EVENT,
                    flags,
                    keyIndex & 0xff,
                    Math.abs(rssi) & 0xff, // the event carries the magnitude (see statusRssiByte)
                ]),
                bytes,
            ]),
        );
    }

    /**
     * The status the air hook returns for a response telegram the device sent back: TELEGRAM_SENT_RECVD_ACK with
     * that telegram (the module reports the first answer from the destination this way, whatever its type).
     * @param {Uint8Array} telegram the device's response, as bytes
     * @param {{rssi?: number, keyIndex?: number}} [options]
     */
    static answered(telegram, {rssi = -55, keyIndex = 0} = {}) {
        return {
            status: BIDCOS_STATUS.TELEGRAM_SENT_RECVD_ACK,
            data: Buffer.concat([Buffer.from([keyIndex & 0xff, statusRssiByte(rssi)]), Buffer.from(telegram)]),
        };
    }

    /**
     * The status after an AES handshake the module ran for rfd: AUTHENTICATION_SUCCESS carries the key index, the
     * RSSI and the device's signed acknowledgement; AUTHENTICATION_FAILURE only the key index.
     * @param {boolean} ok
     * @param {{keyIndex: number, rssi?: number, telegram?: Uint8Array}} details
     */
    static authenticated(ok, {keyIndex, rssi = -55, telegram}) {
        if (!ok) {
            return {status: BIDCOS_STATUS.AUTHENTICATION_FAILURE, data: Buffer.from([keyIndex & 0xff])};
        }
        return {
            status: BIDCOS_STATUS.AUTHENTICATION_SUCCESS,
            data: Buffer.concat([Buffer.from([keyIndex & 0xff, statusRssiByte(rssi)]), Buffer.from(telegram)]),
        };
    }

    /**
     * A positive acknowledgement for the air hook: TELEGRAM_SENT_RECVD_ACK with the device's ACK telegram (payload
     * `00` = plain ACK; `01 ch state flags` = ACK_STATUS).
     * @param {object} request the request the air hook received
     * @param {{payload?: ArrayLike<number>, rssi?: number, keyIndex?: number}} [options]
     */
    static acknowledged(request, {payload = [ACK.ACK], rssi = -55, keyIndex = 0} = {}) {
        const t = request.telegram;
        const ack = encodeTelegram({
            counter: t.counter,
            ctrl: CTRL.RPT_ENABLE,
            type: FT.ACK_OR_NACK,
            src: t.dst,
            dst: t.src,
            payload,
        });
        return {
            status: BIDCOS_STATUS.TELEGRAM_SENT_RECVD_ACK,
            data: Buffer.concat([Buffer.from([keyIndex & 0xff, statusRssiByte(rssi)]), ack]),
        };
    }

    close() {
        this.closed = true;
        clearTimeout(this.modeSwitchTimer);
        this.detach();
    }
}

function address3(address) {
    const out = Buffer.alloc(3);
    out.writeUIntBE(address & 0xffffff, 0, 3);
    return out;
}
