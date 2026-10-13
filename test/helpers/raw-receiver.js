/**
 * A callback receiver at byte level, for the misbehaving-receiver tests: it speaks BIN-RPC (`xmlrpc_bin://`) or
 * XML-RPC over HTTP (`http://`) well enough to pass the daemon's `init` (system.listMethods, listDevices) and to answer
 * events - and, when told to, misbehaves at any point: closes mid-request, never answers, never reads, answers with an
 * HTTP error, a fault, garbage, a truncated or huge message, the wrong type, byte by byte, or twice.
 *
 * `misbehave(mode, {on})` sets what happens to the requests whose method matches `on` (default: the event calls,
 * `system.multicall` and `event`); every request is recorded with the time it arrived.
 */

import net from 'node:net';
import {createRequire} from 'node:module';

import {encodeResponse, encodeValue, MSG, u32} from '../../lib/binrpc-raw.js';
import {freePort} from './rpc.js';

const require = createRequire(import.meta.url);
const protocol = require('binrpc/lib/protocol.js');

const METHODS = ['system.listMethods', 'system.multicall', 'listDevices', 'newDevices', 'deleteDevices', 'event'];

/** The modes and what they do with a matching request. */
export const MODES = Object.freeze([
    'ok', // answer properly
    'close', // read the whole request, then close the connection without an answer
    'close-partial', // close as soon as the first bytes of the request arrive
    'vanish', // close the connection and the listener: the receiver is gone mid-callback
    'no-answer', // read, never answer, keep the connection open
    'no-read', // read the request, then stop reading the connection
    'deaf', // accept connections and never read from them at all
    'http-500', // HTTP error status (XML-RPC), a fault message (BIN-RPC)
    'fault', // a well-formed fault
    'garbage', // bytes that are no message at all
    'truncated', // a response header promising more than follows, then nothing
    'wrong-type', // a valid response of the wrong type (a struct where an array or a string is expected)
    'huge', // a valid response of several MB
    'trickle', // the proper response, one byte every 100 ms
    'twice', // the proper response, twice (an answer for a request that was never sent)
    // the lazy servers of OpenCCU-Base fc83bfd4 (libXmlRpc's XmlRpcClient::readHeader); XML-RPC only, BIN-RPC answers
    // properly in these modes
    'empty-length', // HTTP 200 with `Content-Length: 0` and no body at all
    'split-header', // the header alone, ending with \r\n\r\n as the last bytes of a write, the body 300 ms later
    'no-params', // a `<methodResponse>` without `<params>`
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function xmlValue(value) {
    if (Array.isArray(value)) {
        return `<value><array><data>${value.map(xmlValue).join('')}</data></array></value>`;
    }
    if (value && typeof value === 'object') {
        return `<value><struct>${Object.entries(value)
            .map(([k, v]) => `<member><name>${k}</name>${xmlValue(v)}</member>`)
            .join('')}</struct></value>`;
    }
    if (typeof value === 'number') {
        return `<value><i4>${value}</i4></value>`;
    }
    if (typeof value === 'boolean') {
        return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
    }
    return `<value>${String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</value>`;
}

function httpResponse(body, status = '200 OK') {
    const b = Buffer.from(body, 'utf8');
    return Buffer.concat([
        Buffer.from(
            `HTTP/1.1 ${status}\r\nContent-Type: text/xml\r\nContent-Length: ${b.length}\r\nConnection: keep-alive\r\n\r\n`,
        ),
        b,
    ]);
}

export class RawReceiver {
    /** @param {{protocol?: 'binrpc'|'xmlrpc', listDevices?: () => any}} [options] */
    constructor({protocol: proto = 'binrpc', listDevices = () => []} = {}) {
        this.protocol = proto;
        this.listDevices = listDevices;
        this.mode = 'ok';
        this.on = (method) => method === 'system.multicall' || method === 'event';
        /** @type {Array<{method: string, at: number, mode: string, body?: string}>} */
        this.requests = [];
        this.sockets = new Set();
        this.connections = 0;
    }

    /** @param {string} mode one of MODES @param {{on?: string[]|((method: string) => boolean)}} [options] */
    misbehave(mode, {on} = {}) {
        if (!MODES.includes(mode)) {
            throw new Error(`unknown mode ${mode}`);
        }
        this.mode = mode;
        if (on) {
            this.on = typeof on === 'function' ? on : (method) => on.includes(method);
        }
    }

    async start(port) {
        this.port = port ?? (await freePort());
        this.server = net.createServer((socket) => this.connection(socket));
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.port, '127.0.0.1', resolve);
        });
        this.url = this.protocol === 'xmlrpc' ? `http://127.0.0.1:${this.port}` : `xmlrpc_bin://127.0.0.1:${this.port}`;
        return this;
    }

    connection(socket) {
        this.connections++;
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => {});
        if (this.mode === 'deaf') {
            this.record('(deaf)', 'deaf');
            socket.pause();
            return;
        }
        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                const message = this.protocol === 'xmlrpc' ? this.takeHttp(buffer) : this.takeBin(buffer);
                if (message === 'partial-check') {
                    // the first bytes of a request whose method we cannot know yet: close-partial acts on any
                    if (this.mode === 'close-partial') {
                        this.record('(partial)', 'close-partial');
                        socket.destroy();
                    }
                    return;
                }
                if (!message) {
                    return;
                }
                buffer = buffer.subarray(message.length);
                this.handle(socket, message.method, message.params, message.body);
                if (socket.destroyed || socket.isPaused()) {
                    return;
                }
            }
        });
    }

    /** One BIN-RPC request from the buffer, or null / 'partial-check'. */
    takeBin(buffer) {
        if (buffer.length < 8) {
            return buffer.length > 0 ? 'partial-check' : null;
        }
        const length = 8 + buffer.readUInt32BE(4);
        if (buffer.length < length) {
            return 'partial-check';
        }
        let decoded = null;
        try {
            decoded = protocol.decodeRequest(Buffer.from(buffer.subarray(0, length)));
        } catch {
            decoded = null;
        }
        return {length, method: decoded ? decoded.method : '(undecodable)', params: decoded ? decoded.params : []};
    }

    /** One HTTP request from the buffer, or null / 'partial-check'. */
    takeHttp(buffer) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) {
            return buffer.length > 0 ? 'partial-check' : null;
        }
        const head = buffer.subarray(0, end).toString('latin1');
        const m = /content-length:\s*(\d+)/i.exec(head);
        const length = end + 4 + (m ? Number(m[1]) : 0);
        if (buffer.length < length) {
            return 'partial-check';
        }
        const body = buffer.subarray(end + 4, length).toString('utf8');
        const method = (/<methodName>([^<]*)<\/methodName>/.exec(body) || [])[1] || '(none)';
        const calls = method === 'system.multicall' ? (body.match(/<name>methodName<\/name>/g) || []).length : 0;
        return {length, method, params: [calls], body};
    }

    record(method, mode, body) {
        this.requests.push({method, at: Date.now(), mode, ...(body !== undefined ? {body} : {})});
    }

    /** The proper answer value of a request. */
    answerValue(method, params) {
        if (method === 'system.listMethods') {
            return METHODS;
        }
        if (method === 'listDevices') {
            return this.listDevices();
        }
        if (method === 'system.multicall') {
            const n = this.protocol === 'xmlrpc' ? params[0] : (params[0] || []).length;
            return Array.from({length: n}, () => ['']);
        }
        return '';
    }

    encode(value) {
        return this.protocol === 'xmlrpc'
            ? httpResponse(
                  `<?xml version="1.0"?><methodResponse><params><param>${xmlValue(value)}</param></params></methodResponse>`,
              )
            : encodeResponse(value);
    }

    fault() {
        if (this.protocol === 'xmlrpc') {
            return httpResponse(
                `<?xml version="1.0"?><methodResponse><fault>${xmlValue({faultCode: -1, faultString: 'misbehaving receiver'})}</fault></methodResponse>`,
            );
        }
        const body = encodeValue({faultCode: -1, faultString: 'misbehaving receiver'});
        return Buffer.concat([Buffer.from('Bin'), Buffer.from([MSG.FAULT]), u32(body.length), body]);
    }

    handle(socket, method, params, body) {
        const mode = this.on(method) ? this.mode : 'ok';
        this.record(method, mode, body);
        const proper = () => this.encode(this.answerValue(method, params));
        switch (mode) {
            case 'ok':
                socket.write(proper());
                return;
            case 'close':
            case 'close-partial':
                socket.destroy();
                return;
            case 'vanish':
                socket.destroy();
                this.stop();
                return;
            case 'no-answer':
                return;
            case 'no-read':
                socket.pause();
                return;
            case 'http-500':
                socket.write(
                    this.protocol === 'xmlrpc' ? httpResponse('oops', '500 Internal Server Error') : this.fault(),
                );
                return;
            case 'fault':
                socket.write(this.fault());
                return;
            case 'garbage':
                socket.write(Buffer.from('\x00\xffNOT A RESPONSE\r\n\r\n<<<>>>\x01\x02\x03', 'latin1'));
                return;
            case 'truncated':
                socket.write(
                    this.protocol === 'xmlrpc'
                        ? Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: 5000\r\n\r\n<?xml ')
                        : Buffer.concat([
                              Buffer.from('Bin'),
                              Buffer.from([MSG.RESPONSE]),
                              u32(5000),
                              Buffer.from([0, 0, 0, 3]),
                          ]),
                );
                return;
            case 'wrong-type':
                socket.write(this.encode({unexpected: 'struct', where: 'an array or a string belongs'}));
                return;
            case 'huge':
                socket.write(this.encode(['x'.repeat(4 * 1024 * 1024)]));
                return;
            case 'trickle':
                this.trickle(socket, proper());
                return;
            case 'twice':
                socket.write(Buffer.concat([proper(), proper()]));
                return;
            case 'empty-length':
                socket.write(
                    this.protocol === 'xmlrpc'
                        ? Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: 0\r\n\r\n')
                        : proper(),
                );
                return;
            case 'split-header':
                if (this.protocol === 'xmlrpc') {
                    const bytes = proper();
                    const end = bytes.indexOf('\r\n\r\n') + 4;
                    socket.write(bytes.subarray(0, end));
                    setTimeout(() => socket.destroyed || socket.write(bytes.subarray(end)), 300);
                } else {
                    socket.write(proper());
                }
                return;
            case 'no-params':
                socket.write(
                    this.protocol === 'xmlrpc'
                        ? httpResponse('<?xml version="1.0"?><methodResponse></methodResponse>')
                        : proper(),
                );
                return;
            default:
                socket.write(proper());
        }
    }

    async trickle(socket, bytes) {
        for (const byte of bytes) {
            if (socket.destroyed) {
                return;
            }
            socket.write(Buffer.from([byte]));
            await sleep(100);
        }
    }

    calls(method) {
        return this.requests.filter((r) => r.method === method);
    }

    async stop() {
        for (const s of this.sockets) {
            s.destroy();
        }
        if (this.server && this.server.listening) {
            await new Promise((resolve) => this.server.close(() => resolve()));
        }
    }
}

export async function startRawReceiver(options) {
    return new RawReceiver(options).start();
}
