/**
 * RPC plumbing for the daemon tests: promisified BIN-RPC and XML-RPC calls, a raw BIN-RPC sender for malformed
 * messages, a callback receiver that records what the daemon calls on it.
 */

import net from 'node:net';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const binrpc = require('binrpc');
const xmlrpc = require('homematic-xmlrpc');

/**
 * @param {number} port
 * @returns {Promise<number>} a free TCP port on 127.0.0.1
 */
export function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const {port} = server.address();
            server.close(() => resolve(port));
        });
    });
}

function withTimeout(promise, ms, what) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A BIN-RPC client bound to one daemon port. Every call gets a timeout, because a dead daemon answers nothing.
 */
export class BinRpcClient {
    constructor(port, host = '127.0.0.1') {
        this.client = binrpc.createClient({host, port, reconnectTimeout: 500});
    }

    call(method, params = [], {timeout = 10000} = {}) {
        const call = new Promise((resolve, reject) => {
            this.client.methodCall(method, params, (error, result) => (error ? reject(error) : resolve(result)));
        });
        return withTimeout(call, timeout, `binrpc ${method}`);
    }
}

export class XmlRpcClient {
    constructor(port, host = '127.0.0.1') {
        this.client = xmlrpc.createClient({host, port, path: '/'});
    }

    call(method, params = [], {timeout = 10000} = {}) {
        const call = new Promise((resolve, reject) => {
            this.client.methodCall(method, params, (error, result) => (error ? reject(error) : resolve(result)));
        });
        return withTimeout(call, timeout, `xmlrpc ${method}`);
    }
}

/**
 * Sends raw bytes to a port and collects whatever comes back until the peer closes or nothing arrives for a while.
 * @param {number} port
 * @param {Buffer} bytes
 * @param {{idleMs?: number, maxMs?: number}} [options]
 * @returns {Promise<{response: Buffer, closedByPeer: boolean, error: string|null}>}
 */
export function sendRaw(port, bytes, {idleMs = 1500, maxMs = 8000} = {}) {
    return new Promise((resolve) => {
        const chunks = [];
        let closedByPeer = false;
        let error = null;
        let idle;
        const socket = net.connect({host: '127.0.0.1', port});
        const finish = () => {
            clearTimeout(idle);
            clearTimeout(max);
            socket.destroy();
            resolve({response: Buffer.concat(chunks), closedByPeer, error});
        };
        const max = setTimeout(finish, maxMs);
        const armIdle = () => {
            clearTimeout(idle);
            idle = setTimeout(finish, idleMs);
        };
        socket.on('connect', () => {
            socket.write(bytes);
            armIdle();
        });
        socket.on('data', (chunk) => {
            chunks.push(chunk);
            armIdle();
        });
        socket.on('end', () => {
            closedByPeer = true;
            finish();
        });
        socket.on('close', () => {
            closedByPeer = true;
            finish();
        });
        socket.on('error', (e) => {
            error = e.code || e.message;
            finish();
        });
    });
}

/**
 * Sends an HTTP POST with an XML-RPC body of any shape and returns the raw answer.
 * @param {number} port
 * @param {string} xml
 */
export function sendRawXml(port, xml, options) {
    const body = Buffer.from(xml, 'utf8');
    const head = Buffer.from(
        `POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/xml\r\nContent-Length: ${body.length}\r\n\r\n`,
        'ascii',
    );
    return sendRaw(port, Buffer.concat([head, body]), options);
}

/**
 * A logic-layer stand-in the daemon calls back after `init`: it answers the methods rfd and hs485d use and records
 * every call.
 * @param {{methods?: Record<string, (params: any[]) => any>}} [options]
 * @returns {Promise<Receiver>}
 */
export async function startReceiver(options = {}) {
    const receiver = new Receiver(options);
    await receiver.start();
    return receiver;
}

export class Receiver {
    constructor({methods = {}} = {}) {
        this.methods = {
            'system.listMethods': () => [
                'system.listMethods',
                'system.multicall',
                'listDevices',
                'newDevices',
                'deleteDevices',
                'event',
            ],
            listDevices: () => [],
            newDevices: () => '',
            deleteDevices: () => '',
            event: () => '',
            ...methods,
        };
        /** @type {Array<{method: string, params: any[], at: number}>} */
        this.received = [];
        this.waiters = [];
        this.sockets = new Set();
    }

    async start() {
        this.port = await freePort();
        await new Promise((resolve, reject) => {
            this.server = binrpc.createServer({host: '127.0.0.1', port: this.port}, resolve);
            this.server.on('error', reject);
            for (const method of Object.keys(this.methods)) {
                this.server.on(method, (_error, params, callback) => this.dispatch(method, params, callback));
            }
            this.server.on('NotFound', (method, params) => this.record(method, params));
        });
        this.server.server.on('connection', (socket) => {
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
        });
        this.url = `xmlrpc_bin://127.0.0.1:${this.port}`;
    }

    dispatch(method, params, callback) {
        this.record(method, params);
        if (method === 'system.multicall') {
            const calls = params[0] || [];
            const results = calls.map((c) => {
                this.record(c.methodName, c.params);
                const handler = this.methods[c.methodName];
                return [handler ? handler(c.params) : ''];
            });
            callback(null, results);
            return;
        }
        callback(null, this.methods[method](params));
    }

    record(method, params) {
        const entry = {method, params, at: Date.now()};
        this.received.push(entry);
        this.waiters = this.waiters.filter((w) => !w(entry));
    }

    /**
     * @param {string} method
     * @param {number} [timeout]
     * @returns {Promise<{method: string, params: any[]}>}
     */
    waitFor(method, timeout = 10000) {
        const found = this.received.find((r) => r.method === method);
        if (found) {
            return Promise.resolve(found);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(
                    new Error(
                        `receiver: no ${method} within ${timeout} ms; got ${this.received.map((r) => r.method).join(' ') || 'nothing'}`,
                    ),
                );
            }, timeout);
            this.waiters.push((entry) => {
                if (entry.method === method) {
                    clearTimeout(timer);
                    resolve(entry);
                    return true;
                }
                return false;
            });
        });
    }

    calls(method) {
        return this.received.filter((r) => r.method === method);
    }

    /** Stops listening and cuts every open connection - the receiver is gone. */
    async stop() {
        for (const socket of this.sockets) {
            socket.destroy();
        }
        await new Promise((resolve) => this.server.server.close(() => resolve()));
    }
}
