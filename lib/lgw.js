/**
 * A simulated HM-LGW in JavaScript: the LAN gateway's TCP front with the text preamble, the keepalive port and,
 * with a LAN key, the AES-128-CFB transport encryption - in front of the same simulated module the pty uses.
 * Where hmlangw (lib/hmlangw.js) is the production relay without encryption, this front owns the protocol, so the
 * encrypted path and the reconnect scenarios of rfd's LGW code (libUnifiedLanComm, LGWPortWrapper) can be driven:
 * drop one port or both, answer the hello with another serial, stay silent on the keepalive, come back later.
 *
 * The preamble on both ports (public: OpenCCU-Base's libUnifiedLanComm is the client side of it, hmlangw the
 * plaintext gateway side, Homegear's HM-LGW.cpp and FHEM's HMUARTLGW the encrypted one):
 *
 *     gateway: H<nn>,01,<product>,<firmware>,<serial>\r\n      (nn: a hex message counter)
 *     gateway: V<nn>,<32 hex: the gateway's IV>\r\n            (only with a key)
 *     client:  V<nn+1>,<32 hex: the client's IV>\r\n           (plaintext; from here on everything is encrypted)
 *     gateway: S<nn>,BidCoS-over-LAN-1.0\r\n                   (SysCom-1.0 on the keepalive port)
 *     client:  ><nn>,0000\r\n
 *
 * The key is MD5(LAN key). The client encrypts with the gateway's IV and decrypts with its own, so the gateway does
 * the opposite: it decrypts the client's bytes with its own IV and encrypts what it sends with the client's IV. After
 * the preamble the BidCoS port carries the module's serial frames as they are; the keepalive port carries `L`/`K`
 * lines answered with `>L`/`>K`, the `K` counter incrementing, and the gateway drops a keepalive connection that is
 * silent for 20 s (hmlangw's number; the real gateway's is not public).
 */

import {EventEmitter} from 'node:events';
import crypto from 'node:crypto';
import net from 'node:net';
import {Duplex} from 'node:stream';

export const LGW_BIDCOS_PORT = 2000;
export const LGW_KEEPALIVE_PORT = 2001;

/** @param {string} lanKey */
export function lanKeyToAesKey(lanKey) {
    return crypto.createHash('md5').update(lanKey, 'utf8').digest();
}

/** A duplex the module attaches to: what it writes goes to `out`, what arrives through `feed()` is readable. */
class ModuleSide extends Duplex {
    constructor(out) {
        super();
        this.out = out;
    }

    _write(chunk, encoding, callback) {
        this.out(chunk);
        callback();
    }

    _read() {}

    feed(chunk) {
        this.push(chunk);
    }
}

/**
 * One client connection with the preamble state machine and the optional ciphers. The front it belongs to says what
 * the connection's kind is for: `protocolName(kind)` (the name after `S`), `relays(kind)` (binary bytes after the
 * switch go to `onClientBytes(kind, chunk)`), `keepsAlive(kind)` (the text keepalive `L`/`K` lines of the HM-LGW's
 * second port). The HM-LGW front (below) and the HMW-LGW front (hmwlgw.js) both use it.
 */
export class LgwConnection {
    constructor(front, socket, kind) {
        this.front = front;
        this.socket = socket;
        this.kind = kind; // 'bidcos' | 'keepalive'
        this.counter = 0;
        this.state = 'hello';
        this.buffer = Buffer.alloc(0);
        this.clientIv = null;
        this.gatewayIv = null;
        this.encrypt = null;
        this.decrypt = null;
        this.keepaliveCount = 0;
        this.silenceTimer = null;
        this.closed = false;
        this.pending = [];
        this.flushScheduled = false;
        this.segmentChain = Promise.resolve();
        this.segmentsWritten = 0;
        socket.setNoDelay(true);
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('close', () => this.onClose());
        socket.on('error', () => {});
    }

    nextCounter() {
        this.counter = (this.counter + 1) & 0xff;
        return this.counter;
    }

    hex2(n) {
        return n.toString(16).padStart(2, '0');
    }

    /** Sends a text line, encrypted once the ciphers are up. */
    sendLine(line) {
        this.front.log(`${this.kind} > ${line}`);
        this.front.trace.push({at: Date.now(), kind: this.kind, dir: 'tx', line});
        this.sendRaw(Buffer.from(`${line}\r\n`, 'ascii'));
    }

    sendRaw(bytes) {
        if (this.closed || this.socket.destroyed) {
            return;
        }
        const data = this.encrypt ? this.encrypt.update(bytes) : bytes;
        const segmentation = this.front.segmentation;
        if (!segmentation) {
            this.socket.write(data);
            return;
        }
        // TCP segmentation as a slow or busy gateway produces it: what is sent in one tick is gathered (two messages
        // in one segment) and each segment is cut into pieces written `gapMs` apart (one message across segments).
        // The cipher stream is cut after encryption, so the byte stream stays the same.
        this.pending.push(data);
        if (!this.flushScheduled) {
            this.flushScheduled = true;
            setImmediate(() => this.flushSegments());
        }
    }

    flushSegments() {
        this.flushScheduled = false;
        const {pieces = 1, gapMs = 50, coalesce = true} = this.front.segmentation || {};
        const units = coalesce ? [Buffer.concat(this.pending)] : this.pending;
        this.pending = [];
        for (const unit of units) {
            const size = Math.max(1, Math.ceil(unit.length / pieces));
            for (let offset = 0; offset < unit.length; offset += size) {
                const piece = unit.subarray(offset, offset + size);
                const first = this.segmentsWritten === 0;
                this.segmentChain = this.segmentChain.then(async () => {
                    if (!first) {
                        await new Promise((resolve) => setTimeout(resolve, gapMs));
                    }
                    if (!this.closed && !this.socket.destroyed) {
                        this.socket.write(piece);
                        this.front.segments++;
                    }
                });
                this.segmentsWritten++;
            }
        }
    }

    start() {
        const f = this.front;
        const serial = f.helloSerial(this.kind);
        const fields = ['01', f.product, f.firmware, ...(serial === null ? [] : [serial])];
        this.sendLine(`H${this.hex2(this.nextCounter())},${fields.join(',')}`);
        if (f.aesKey) {
            this.gatewayIv = crypto.randomBytes(16);
            this.sendLine(`V${this.hex2(this.nextCounter())},${this.gatewayIv.toString('hex').toUpperCase()}`);
            this.state = 'iv';
        } else {
            this.sendSwitch();
        }
    }

    sendSwitch() {
        const protocol = this.front.protocolName(this.kind);
        this.switchCounter = this.nextCounter();
        this.sendLine(`S${this.hex2(this.switchCounter)},${protocol}`);
        this.state = 'switch';
    }

    onData(chunk) {
        if (this.decrypt) {
            chunk = this.decrypt.update(chunk);
        }
        if (this.state === 'relay' && this.front.relays(this.kind)) {
            this.front.trace.push({at: Date.now(), kind: this.kind, dir: 'rx', bytes: chunk.length});
            this.front.onClientBytes(this.kind, chunk);
            return;
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        let index;
        while ((index = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.subarray(0, index).toString('ascii').replace(/\r$/, '');
            this.buffer = this.buffer.subarray(index + 1);
            this.onLine(line);
            if (this.state === 'relay' && this.front.relays(this.kind)) {
                if (this.buffer.length) {
                    this.front.onClientBytes(this.kind, this.buffer);
                    this.buffer = Buffer.alloc(0);
                }
                return;
            }
        }
    }

    onLine(line) {
        const f = this.front;
        f.log(`${this.kind} < ${line}`);
        f.trace.push({at: Date.now(), kind: this.kind, dir: 'rx', line});
        if (this.state === 'iv') {
            const m = /^V([0-9a-fA-F]{2}),([0-9a-fA-F]{32})$/.exec(line);
            if (!m) {
                f.log(`${this.kind}: expected the client's IV, got ${JSON.stringify(line)}; closing`);
                this.socket.destroy();
                return;
            }
            this.clientIv = Buffer.from(m[2], 'hex');
            // the client encrypts with our IV and decrypts with its own: we do the opposite
            this.decrypt = crypto.createDecipheriv('aes-128-cfb', f.aesKey, this.gatewayIv);
            this.encrypt = crypto.createCipheriv('aes-128-cfb', f.aesKey, this.clientIv);
            f.emit('encrypted', this.kind);
            this.sendSwitch();
            return;
        }
        if (this.state === 'switch') {
            const m = /^>([0-9a-fA-F]{2}),(\d+)$/.exec(line);
            if (!m || parseInt(m[1], 16) !== this.switchCounter || Number(m[2]) !== 0) {
                f.log(`${this.kind}: bad switch answer ${JSON.stringify(line)}; closing`);
                this.socket.destroy();
                return;
            }
            this.state = 'relay';
            f.emit('connected', this.kind);
            if (f.keepsAlive(this.kind)) {
                this.armSilenceTimer();
            }
            return;
        }
        if (this.state === 'relay' && f.keepsAlive(this.kind)) {
            this.onKeepaliveLine(line);
        }
    }

    onKeepaliveLine(line) {
        const f = this.front;
        this.armSilenceTimer();
        const m = /^([LK])([0-9a-fA-F]{2})(?:,(.*))?$/.exec(line);
        if (!m) {
            return;
        }
        const counter = parseInt(m[2], 16);
        if (m[1] === 'L') {
            this.keepaliveCount = counter;
            f.emit('led', m[3] || '');
        } else {
            this.keepaliveCount = (this.keepaliveCount + 1) & 0xff;
            if (counter !== this.keepaliveCount) {
                f.log(`keepalive counter ${counter} != expected ${this.keepaliveCount}; closing`);
                this.socket.destroy();
                return;
            }
            f.keepalives++;
            f.emit('keepalive', counter);
        }
        if (f.answerKeepalive) {
            this.sendLine(`>${m[1]}${this.hex2(counter)}`);
        }
    }

    armSilenceTimer() {
        clearTimeout(this.silenceTimer);
        if (this.front.keepaliveSilenceMs > 0) {
            this.silenceTimer = setTimeout(() => {
                this.front.log('keepalive silent; closing');
                this.socket.destroy();
            }, this.front.keepaliveSilenceMs);
        }
    }

    onClose() {
        this.closed = true;
        clearTimeout(this.silenceTimer);
        this.front.onConnectionClosed(this);
    }

    destroy() {
        this.socket.destroy();
    }
}

export class LgwFront extends EventEmitter {
    /**
     * @param {{module: import('./module.js').RadioModule, serial?: string, key?: string, listen?: string,
     *   bidcosPort?: number, keepalivePort?: number, product?: string, firmware?: string, log?: (line: string) => void,
     *   keepaliveSilenceMs?: number, segmentation?: {pieces?: number, gapMs?: number, coalesce?: boolean}|null}} options `key` is the LAN key ('' = plaintext, as with no key configured)
     */
    constructor({
        module,
        serial = module.serial,
        key = '',
        listen = '127.0.0.1',
        bidcosPort = LGW_BIDCOS_PORT,
        keepalivePort = LGW_KEEPALIVE_PORT,
        product = 'eQ3-HM-LGW',
        firmware = '1.1.5',
        log = () => {},
        keepaliveSilenceMs = 20000,
        segmentation = null,
    }) {
        super();
        this.module = module;
        this.serial = serial;
        this.key = key;
        this.aesKey = key ? lanKeyToAesKey(key) : null;
        this.listen = listen;
        this.bidcosPort = bidcosPort;
        this.keepalivePort = keepalivePort;
        this.product = product;
        this.firmware = firmware;
        this.log = log;
        this.keepaliveSilenceMs = keepaliveSilenceMs;
        /** Set to answer the hello with another serial (once, then back to the real one). */
        this.serialOverrideOnce = null;
        /**
         * A serial per port for every hello until it is set back to null (`{keepalive: 'OTHER00001'}`: port 2001
         * names another gateway than port 2000); the value `false` leaves the serial field out of the hello (three
         * parameters instead of four).
         * @type {{bidcos?: string|false|null, keepalive?: string|false|null}}
         */
        this.serialByPort = {};
        /**
         * TCP segmentation of what the gateway sends, e.g. `{pieces: 3, gapMs: 50, coalesce: true}` (see
         * LgwConnection.sendRaw); null writes every message as one segment.
         * @type {{pieces?: number, gapMs?: number, coalesce?: boolean}|null}
         */
        this.segmentation = segmentation;
        /** The segments written while segmentation is on. */
        this.segments = 0;
        /** When false the keepalive lines get no `>K` answer (rfd reconnects after 4 s). */
        this.answerKeepalive = true;
        this.keepalives = 0;
        this.connections = {bidcos: null, keepalive: null};
        /** @type {Array<{at: number, kind: string, dir: string, line?: string, bytes?: number}>} */
        this.trace = [];
        this.servers = {bidcos: null, keepalive: null};
        /** The ports actually bound (port 0 in the options picks free ones, for the unit tests). */
        this.ports = {bidcos: bidcosPort, keepalive: keepalivePort};
        this.moduleSide = new ModuleSide((chunk) => this.onModuleOutput(chunk));
        this.starts = 0;
        this.clientsSeen = {bidcos: 0, keepalive: 0};
    }

    get host() {
        return this.listen;
    }

    /**
     * The serial the next hello on a port names; null = no serial field.
     * @param {string} [kind]
     */
    helloSerial(kind) {
        const byPort = kind ? this.serialByPort[kind] : undefined;
        if (byPort === false) {
            return null;
        }
        if (typeof byPort === 'string') {
            return byPort;
        }
        if (this.serialOverrideOnce) {
            const s = this.serialOverrideOnce;
            this.serialOverrideOnce = null;
            return s;
        }
        return this.serial;
    }

    /** Opens both ports; the module is attached to the front's stream. */
    async start() {
        this.module.attach(this.moduleSide);
        for (const kind of ['bidcos', 'keepalive']) {
            await this.listenOn(kind);
        }
        this.starts++;
    }

    listenOn(kind) {
        const port = this.ports[kind] || (kind === 'bidcos' ? this.bidcosPort : this.keepalivePort);
        return new Promise((resolve, reject) => {
            const server = net.createServer((socket) => this.accept(kind, socket));
            server.once('error', reject);
            server.listen(port, this.listen, () => {
                this.servers[kind] = server;
                this.ports[kind] = server.address().port;
                resolve();
            });
        });
    }

    accept(kind, socket) {
        this.clientsSeen[kind]++;
        if (this.connections[kind]) {
            // one client at a time, as hmlangw and the gateway do
            this.log(`${kind}: a second client; closing it`);
            socket.destroy();
            return;
        }
        const connection = new LgwConnection(this, socket, kind);
        this.connections[kind] = connection;
        this.log(`${kind}: client connected`);
        this.emit('client', kind);
        connection.start();
    }

    onConnectionClosed(connection) {
        if (this.connections[connection.kind] === connection) {
            this.connections[connection.kind] = null;
            this.log(`${connection.kind}: client gone`);
            this.emit('clientGone', connection.kind);
        }
    }

    protocolName(kind) {
        return kind === 'bidcos' ? 'BidCoS-over-LAN-1.0' : 'SysCom-1.0';
    }

    relays(kind) {
        return kind === 'bidcos';
    }

    keepsAlive(kind) {
        return kind === 'keepalive';
    }

    onClientBytes(kind, chunk) {
        this.onModuleBytes(chunk);
    }

    /** Bytes from the client after the preamble: the module's input. */
    onModuleBytes(chunk) {
        this.moduleSide.feed(chunk);
    }

    /** Bytes the module wrote: to the BidCoS client, when one is in relay state. */
    onModuleOutput(chunk) {
        const c = this.connections.bidcos;
        if (c && c.state === 'relay') {
            this.trace.push({at: Date.now(), kind: 'bidcos', dir: 'tx', bytes: chunk.length});
            c.sendRaw(chunk);
        }
    }

    /** Drops the client on one port (the connection, not the listener). */
    drop(kind) {
        const c = this.connections[kind];
        if (c) {
            c.destroy();
        }
    }

    /** Closes a listener: the port is refused until listenOn() again. */
    async closePort(kind) {
        this.drop(kind);
        const server = this.servers[kind];
        if (server) {
            this.servers[kind] = null;
            await new Promise((resolve) => server.close(() => resolve()));
        }
    }

    /** The gateway is gone: both ports closed, both clients dropped. */
    async lose() {
        await this.closePort('bidcos');
        await this.closePort('keepalive');
    }

    /** The gateway is back on the same module. */
    async reappear() {
        for (const kind of ['bidcos', 'keepalive']) {
            if (!this.servers[kind]) {
                await this.listenOn(kind);
            }
        }
        this.starts++;
    }

    async close() {
        await this.lose();
        this.module.detach();
    }
}

/**
 * @param {ConstructorParameters<typeof LgwFront>[0]} options
 * @returns {Promise<LgwFront>}
 */
export async function createLgwFront(options) {
    const front = new LgwFront(options);
    await front.start();
    return front;
}
