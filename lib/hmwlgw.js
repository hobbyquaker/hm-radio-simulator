/**
 * The HomeMatic Wired LAN gateway (HMW-LGW) in JavaScript, for hs485d's `-g` mode: one TCP port with the same text
 * preamble as the HM-LGW (hello, the optional AES-128-CFB handshake, the protocol switch - libUnifiedLanComm is shared
 * by both daemons; `LgwConnection` of lgw.js carries it), then binary transport frames:
 *
 *     0xFD, length, payload          (0xFC escapes 0xFC and 0xFD in the payload: 0xFC, byte & 0x7F)
 *     payload = counter, command, data
 *
 * The commands hs485d sends (HMWLGWCommand.h of OpenCCU-Base): `K` keepalive every 20 s, answered `a 00` within
 * 700 ms (HS485_RESPONSE_TIMEOUT) or hs485d reconnects; `D 00 FF` discovery, answered with one `d` + address(4) per
 * device and `c` + code(1) + count(2) at the end; `S` timeout(1) receiver(4) control(1) sender(4) data = a frame for
 * the bus, answered with the device's reply `r` control data (the request's counter) or `a 01` when nothing answered;
 * `L` log level. A frame a device sends on its own becomes `e` receiver(4) control(1) sender(4) data with the
 * gateway's own counter. (Homegear's HMW-LGW.cpp, read as documentation, agrees on the letters and the answers.)
 */

import net from 'node:net';
import {EventEmitter} from 'node:events';
import {LgwConnection, lanKeyToAesKey} from './lgw.js';
import {WIRED_BROADCAST, describeWired} from './wired.js';

export const HMW_LGW_PORT = 1000;
const FRAME_START = 0xfd;
const ESCAPE = 0xfc;

/** Escapes a payload and wraps it into a transport frame. */
export function encodeTransportFrame(payload) {
    const out = [FRAME_START, payload.length & 0xff];
    for (const b of payload) {
        if (b === FRAME_START || b === ESCAPE) {
            out.push(ESCAPE, b & 0x7f);
        } else {
            out.push(b);
        }
    }
    return Buffer.from(out);
}

/** A streaming parser for transport frames, the way hs485d's HMWLGWTransportFrame reassembles them. */
export class TransportParser {
    constructor(onFrame) {
        this.onFrame = onFrame;
        this.payload = [];
        this.expected = -1;
        this.escaping = false;
        this.inFrame = false;
    }

    feed(chunk) {
        for (let b of chunk) {
            if (b === FRAME_START && this.inFrame && this.payload.length > 0) {
                // a new start inside a frame: the old one will never complete (hs485d does the same)
                this.payload = [];
                this.expected = -1;
            }
            if (b === FRAME_START && !this.escaping) {
                this.inFrame = true;
                this.payload = [];
                this.expected = -1;
                continue;
            }
            if (!this.inFrame) {
                continue;
            }
            if (this.escaping) {
                b |= 0x80;
                this.escaping = false;
            } else if (b === ESCAPE) {
                this.escaping = true;
                continue;
            }
            if (this.expected === -1) {
                this.expected = b;
                if (this.expected === 0) {
                    this.inFrame = false;
                    this.onFrame(Buffer.alloc(0));
                }
                continue;
            }
            this.payload.push(b);
            if (this.payload.length >= this.expected) {
                const frame = Buffer.from(this.payload);
                this.inFrame = false;
                this.payload = [];
                this.onFrame(frame);
            }
        }
    }
}

export class HmwLgwFront extends EventEmitter {
    /**
     * @param {{bus: import('./wired.js').WiredBus, serial?: string, key?: string, listen?: string, port?: number,
     *   product?: string, firmware?: string, log?: (line: string) => void, keepaliveSilenceMs?: number,
     *   discoveryGapMs?: number, discoveryMs?: number}} options `key` is the LAN key ('' = plaintext); `port` 0 picks
     *   a free one; `discoveryMs` is the time from `D` to the closing `c` (default 1750 ms, **measured** 2026-10-11 on a
     *   real HMW-LGW 1.0.5 with one device: hs485d logged the end of the discovery 1.79 s after sending `D`), the `d`
     *   answers `discoveryGapMs` apart before it; `firmware` defaults to the measured gateway's 1.0.5
     */
    constructor({
        bus,
        serial = 'SIMWLGW001',
        key = '',
        listen = '127.0.0.1',
        port = 0,
        product = 'eQ3-HMW-LGW',
        firmware = '1.0.5',
        log = () => {},
        keepaliveSilenceMs = 60000,
        discoveryGapMs = 30,
        discoveryMs = 1750,
    }) {
        super();
        this.bus = bus;
        this.serial = serial;
        this.key = key;
        this.aesKey = key ? lanKeyToAesKey(key) : null;
        this.listen = listen;
        this.port = port;
        this.product = product;
        this.firmware = firmware;
        this.log = log;
        this.keepaliveSilenceMs = keepaliveSilenceMs;
        this.discoveryGapMs = discoveryGapMs;
        this.discoveryMs = discoveryMs;
        this.serialOverrideOnce = null;
        this.answerKeepalive = true;
        /** Set to make the gateway swallow the devices' answers (as if the bus were dead). */
        this.busDead = false;
        this.keepalives = 0;
        this.discoveries = 0;
        this.counter = 0;
        this.starts = 0;
        this.clientsSeen = 0;
        this.server = null;
        this.connection = null;
        this.parser = new TransportParser((frame) => this.onFrame(frame));
        this.silenceTimer = null;
        /** @type {Array<{at: number, kind: string, dir: string, line?: string, bytes?: number, cmd?: string, hex?: string}>} */
        this.trace = [];
        bus.on('event', (event) => this.onBusEvent(event));
    }

    get host() {
        return this.listen;
    }

    // --- what LgwConnection asks of its front ---

    protocolName() {
        return 'HMWired-over-LAN-1.0';
    }

    relays() {
        return true;
    }

    keepsAlive() {
        return false;
    }

    helloSerial() {
        if (this.serialOverrideOnce) {
            const s = this.serialOverrideOnce;
            this.serialOverrideOnce = null;
            return s;
        }
        return this.serial;
    }

    onClientBytes(kind, chunk) {
        this.parser.feed(chunk);
    }

    onConnectionClosed(connection) {
        if (this.connection === connection) {
            this.connection = null;
            clearTimeout(this.silenceTimer);
            this.log('wired: client gone');
            this.emit('clientGone');
        }
    }

    // --- the server ---

    async start() {
        await new Promise((resolve, reject) => {
            const server = net.createServer((socket) => this.accept(socket));
            server.once('error', reject);
            server.listen(this.port, this.listen, () => {
                this.server = server;
                this.port = server.address().port;
                resolve();
            });
        });
        this.starts++;
    }

    accept(socket) {
        this.clientsSeen++;
        if (this.connection) {
            this.log('wired: a second client; closing it');
            socket.destroy();
            return;
        }
        this.parser = new TransportParser((frame) => this.onFrame(frame));
        this.connection = new LgwConnection(this, socket, 'wired');
        this.log('wired: client connected');
        this.emit('client');
        this.connection.start();
        this.armSilenceTimer();
    }

    armSilenceTimer() {
        clearTimeout(this.silenceTimer);
        if (this.keepaliveSilenceMs > 0) {
            this.silenceTimer = setTimeout(() => {
                this.log('wired: no keepalive; closing the client');
                this.drop();
            }, this.keepaliveSilenceMs);
        }
    }

    /** Drops the client (the connection, not the listener). */
    drop() {
        if (this.connection) {
            this.connection.destroy();
        }
    }

    /** The gateway is gone: the port closed, the client dropped. */
    async lose() {
        this.drop();
        if (this.server) {
            await new Promise((resolve) => this.server.close(() => resolve()));
            this.server = null;
        }
    }

    /** The gateway is back on the same port. */
    async reappear() {
        if (!this.server) {
            await this.start();
        }
    }

    async close() {
        await this.lose();
        clearTimeout(this.silenceTimer);
    }

    // --- the protocol ---

    nextCounter() {
        this.counter = (this.counter + 1) & 0xff;
        return this.counter;
    }

    send(counter, cmd, data = Buffer.alloc(0)) {
        const payload = Buffer.concat([Buffer.from([counter, cmd.charCodeAt(0)]), Buffer.from(data)]);
        this.trace.push({at: Date.now(), kind: 'wired', dir: 'tx', cmd, hex: payload.toString('hex')});
        if (this.connection && this.connection.state === 'relay') {
            this.connection.sendRaw(encodeTransportFrame(payload));
        }
    }

    onFrame(payload) {
        if (payload.length < 2) {
            return;
        }
        const counter = payload[0];
        const cmd = String.fromCharCode(payload[1]);
        const data = payload.subarray(2);
        this.trace.push({at: Date.now(), kind: 'wired', dir: 'rx', cmd, hex: payload.toString('hex')});
        this.emit('command', {counter, cmd, data});
        switch (cmd) {
            case 'K':
                this.keepalives++;
                this.armSilenceTimer();
                this.emit('keepalive', counter);
                if (this.answerKeepalive) {
                    this.send(counter, 'a', [0x00]);
                }
                return;
            case 'L':
                this.send(counter, 'a', [0x00]);
                return;
            case 'D':
                this.discovery(counter);
                return;
            case 'S':
                this.sendToBus(counter, data);
                return;
            default:
                this.log(`wired: unknown command ${JSON.stringify(cmd)}`);
                this.send(counter, 'a', [0x02]);
        }
    }

    discovery(counter) {
        this.discoveries++;
        const addresses = this.bus.addresses();
        this.emit('discovery', addresses);
        addresses.forEach((address, i) => {
            setTimeout(
                () => {
                    const a = Buffer.alloc(4);
                    a.writeUInt32BE(address, 0);
                    this.send(counter, 'd', a);
                },
                this.discoveryGapMs * (i + 1),
            );
        });
        setTimeout(
            () => this.send(counter, 'c', [0x00, (addresses.length >> 8) & 0xff, addresses.length & 0xff]),
            Math.max(this.discoveryMs, this.discoveryGapMs * (addresses.length + 1)),
        );
    }

    async sendToBus(counter, data) {
        if (data.length < 10) {
            this.send(counter, 'a', [0x02]);
            return;
        }
        const timeoutMs = data[0];
        const receiver = data.readUInt32BE(1);
        const ctrl = data[5];
        const sender = data.readUInt32BE(6);
        const payload = Buffer.from(data.subarray(10));
        const answer = this.busDead ? null : await this.bus.deliver({receiver, ctrl, sender, payload});
        if (receiver === WIRED_BROADCAST) {
            this.send(counter, 'a', [0x00]);
            return;
        }
        if (!answer) {
            // the gateway waited the frame's timeout for the device and gives up
            await new Promise((resolve) => setTimeout(resolve, Math.max(timeoutMs, 50)));
            this.send(counter, 'a', [0x01]);
            return;
        }
        this.send(counter, 'r', Buffer.concat([Buffer.from([answer.ctrl]), answer.data]));
    }

    onBusEvent({receiver, ctrl, sender, payload}) {
        const head = Buffer.alloc(9);
        head.writeUInt32BE(receiver >>> 0, 0);
        head[4] = ctrl;
        head.writeUInt32BE(sender >>> 0, 5);
        this.send(this.nextCounter(), 'e', Buffer.concat([head, payload]));
    }

    /** The commands seen, as "rx K" / "tx a" lines, for diagnostics. */
    commandLines() {
        return this.trace.filter((e) => e.cmd).map((e) => `${e.dir} ${e.cmd}`);
    }
}

/**
 * @param {ConstructorParameters<typeof HmwLgwFront>[0]} options
 */
export async function createHmwLgwFront(options) {
    const front = new HmwLgwFront(options);
    await front.start();
    return front;
}

export {describeWired};
