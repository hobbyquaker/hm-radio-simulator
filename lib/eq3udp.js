/**
 * A simulated eQ-3 LAN device for the UDP device search the daemons run when a LAN gateway is configured by serial
 * (rfd: `Type = HMLGW2` without `IP Address`; hs485d: `-g -s <serial>`, and every HMW-LGW reconnect). The protocol
 * is libLanDeviceUtils' `eQ3Config` (OpenCCU-Base, HMSL, read as the specification): a datagram to UDP port 43439
 * (broadcast, multicast 224.0.0.1 or unicast)
 *
 *     02 | sender id (3) | counter (1) | device type filter \0 | serial \0 | opcode [data]
 *
 * answered to the sender's address and port with the same header (the sender's three id bytes and counter, the
 * device's type and serial) followed by `>`, the opcode, a return code (1 = ok) and the data: for `I` (identify) the
 * firmware version \0 and (uint16 service id, uint16 port) pairs ended by 0000; for `n` (the runtime IP
 * configuration) ip, gateway, netmask, dns1, dns2 (4 bytes each). The type filter may end in `*` (`eQ3-HM-LGW*`).
 */

import dgram from 'node:dgram';
import {EventEmitter} from 'node:events';

export const EQ3_UDP_PORT = 43439;

function cstring(buffer, offset) {
    const end = buffer.indexOf(0, offset);
    if (end === -1) {
        return null;
    }
    return {text: buffer.subarray(offset, end).toString('latin1'), next: end + 1};
}

function ip4(text) {
    return Buffer.from(text.split('.').map((n) => Number(n) & 0xff));
}

/** Parses a request datagram; null when it is not one. */
export function parseRequest(buffer) {
    if (buffer.length < 7 || buffer[0] !== 0x02) {
        return null;
    }
    const type = cstring(buffer, 5);
    if (!type) {
        return null;
    }
    const serial = cstring(buffer, type.next);
    if (!serial || serial.next >= buffer.length) {
        return null;
    }
    return {
        senderId: Buffer.from(buffer.subarray(1, 4)),
        counter: buffer[4],
        typeFilter: type.text,
        serial: serial.text,
        opcode: String.fromCharCode(buffer[serial.next]),
        data: Buffer.from(buffer.subarray(serial.next + 1)),
    };
}

export function typeMatches(filter, type) {
    if (!filter || filter === '*') {
        return true;
    }
    if (filter.endsWith('*')) {
        return type.startsWith(filter.slice(0, -1));
    }
    return filter === type;
}

export class Eq3LanDevice extends EventEmitter {
    /**
     * @param {{type: string, serial: string, firmware?: string, ip: string, gateway?: string, netmask?: string,
     *   dns?: string, services?: Array<[number, number]>, port?: number, bind?: string, log?: (line: string) => void,
     *   answering?: boolean}} options `ip` is what the device reports as its address (where the daemon then connects);
     *   `services` are (id, port) pairs for the identify answer
     */
    constructor({
        type,
        serial,
        firmware = '1.0.2',
        ip,
        gateway = '0.0.0.0',
        netmask = '255.0.0.0',
        dns = '0.0.0.0',
        services = [],
        port = EQ3_UDP_PORT,
        bind = '0.0.0.0',
        log = () => {},
        answering = true,
    }) {
        super();
        this.type = type;
        this.serial = serial;
        this.firmware = firmware;
        this.ip = ip;
        this.gateway = gateway;
        this.netmask = netmask;
        this.dns = dns;
        this.services = services;
        this.port = port;
        this.bind = bind;
        this.log = log;
        this.answering = answering;
        this.socket = null;
        /** @type {Array<{at: number, from: string, opcode: string, typeFilter: string, serial: string, answered: boolean}>} */
        this.requests = [];
    }

    start() {
        return new Promise((resolve, reject) => {
            const socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
            socket.on('error', (error) => {
                this.log(`udp: ${error.message}`);
                reject(error);
            });
            socket.on('message', (message, rinfo) => this.onMessage(message, rinfo));
            socket.bind(this.port, this.bind, () => {
                this.socket = socket;
                this.port = socket.address().port;
                try {
                    socket.setBroadcast(true);
                } catch {
                    // not needed for answering
                }
                resolve();
            });
        });
    }

    onMessage(message, rinfo) {
        const request = parseRequest(message);
        if (!request) {
            this.log(`udp: ${message.length} bytes from ${rinfo.address}:${rinfo.port} that are no request`);
            return;
        }
        const mine =
            typeMatches(request.typeFilter, this.type) && (request.serial === '' || request.serial === this.serial);
        const answered = mine && this.answering && ['I', 'n'].includes(request.opcode);
        this.requests.push({
            at: Date.now(),
            from: `${rinfo.address}:${rinfo.port}`,
            opcode: request.opcode,
            typeFilter: request.typeFilter,
            serial: request.serial,
            answered,
        });
        this.emit('request', request, rinfo);
        this.log(
            `udp: ${request.opcode} for ${request.typeFilter || '*'} ${request.serial || ''} from ${rinfo.address}:${rinfo.port}${answered ? '' : ' (not answered)'}`,
        );
        if (!answered) {
            return;
        }
        const header = Buffer.concat([
            Buffer.from([0x02]),
            request.senderId,
            Buffer.from([request.counter]),
            Buffer.from(`${this.type}\0${this.serial}\0`, 'latin1'),
            Buffer.from(`>${request.opcode}`, 'latin1'),
            Buffer.from([0x01]),
        ]);
        let data;
        if (request.opcode === 'I') {
            const services = Buffer.alloc(this.services.length * 4 + 2);
            this.services.forEach(([id, port], i) => {
                services.writeUInt16BE(id, i * 4);
                services.writeUInt16BE(port, i * 4 + 2);
            });
            data = Buffer.concat([Buffer.from(`${this.firmware}\0`, 'latin1'), services]);
        } else {
            data = Buffer.concat([ip4(this.ip), ip4(this.gateway), ip4(this.netmask), ip4(this.dns), ip4(this.dns)]);
        }
        this.socket.send(Buffer.concat([header, data]), rinfo.port, rinfo.address);
    }

    close() {
        return new Promise((resolve) => {
            if (!this.socket) {
                resolve();
                return;
            }
            this.socket.close(() => resolve());
            this.socket = null;
        });
    }
}

export async function createEq3LanDevice(options) {
    const device = new Eq3LanDevice(options);
    await device.start();
    return device;
}
