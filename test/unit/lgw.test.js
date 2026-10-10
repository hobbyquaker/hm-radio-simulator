import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';

import {RadioModule} from '../../lib/module.js';
import {createLgwFront, lanKeyToAesKey} from '../../lib/lgw.js';
import {encodeFrame, FrameParser} from '../../lib/frame.js';
import {TYPE, SYSTEM, SYSTEM_STATUS, IDENTIFY_APP} from '../../lib/commands.js';

/** A line-and-bytes client that mirrors what rfd's libUnifiedLanComm does, with the optional AES transport. */
class Client {
    constructor(port, key) {
        this.key = key ? lanKeyToAesKey(key) : null;
        this.socket = net.connect({host: '127.0.0.1', port});
        this.socket.setNoDelay(true);
        this.chunks = [];
        this.encrypt = null;
        this.decrypt = null;
        this.closed = false;
        this.socket.on('data', (c) => this.chunks.push(this.decrypt ? this.decrypt.update(c) : c));
        this.socket.on('close', () => (this.closed = true));
        this.socket.on('error', () => {});
    }

    connected() {
        return new Promise((resolve, reject) => {
            this.socket.once('connect', resolve);
            this.socket.once('error', reject);
        });
    }

    async line(timeout = 2000) {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
            const all = Buffer.concat(this.chunks);
            const i = all.indexOf('\n');
            if (i !== -1) {
                this.chunks = [all.subarray(i + 1)];
                return all.subarray(0, i).toString('ascii').replace(/\r$/, '');
            }
            await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error('no line');
    }

    async bytes(n, timeout = 2000) {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
            const all = Buffer.concat(this.chunks);
            if (all.length >= n) {
                this.chunks = [all.subarray(n)];
                return all.subarray(0, n);
            }
            await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error(`no ${n} bytes`);
    }

    send(buffer) {
        this.socket.write(this.encrypt ? this.encrypt.update(buffer) : buffer);
    }

    sendLine(line) {
        this.send(Buffer.from(`${line}\r\n`, 'ascii'));
    }

    /** The preamble as rfd runs it: H, optionally V (then ciphers), S, the `>` answer. Returns the H line. */
    async preamble() {
        const hello = await this.line();
        assert.match(hello, /^H[0-9a-f]{2},01,eQ3-HM-LGW,/);
        let next = await this.line();
        if (next.startsWith('V')) {
            const m = /^V([0-9a-f]{2}),([0-9A-Fa-f]{32})$/.exec(next);
            assert.ok(m, next);
            const gatewayIv = Buffer.from(m[2], 'hex');
            const myIv = crypto.randomBytes(16);
            // the client encrypts with the gateway's IV and decrypts with its own
            this.sendLine(
                `V${((parseInt(m[1], 16) + 1) & 0xff).toString(16).padStart(2, '0')},${myIv.toString('hex')}`,
            );
            this.encrypt = crypto.createCipheriv('aes-128-cfb', this.key, gatewayIv);
            this.decrypt = crypto.createDecipheriv('aes-128-cfb', this.key, myIv);
            next = await this.line();
        }
        const s = /^S([0-9a-f]{2}),(.+)$/.exec(next);
        assert.ok(s, next);
        this.sendLine(`>${s[1]},0000`);
        return {hello, protocol: s[2]};
    }

    close() {
        this.socket.destroy();
    }
}

async function front(key) {
    const module = new RadioModule({responseDelayMs: 0});
    const f = await createLgwFront({module, serial: 'SIM0000002', key, bidcosPort: 0, keepalivePort: 0});
    return {module, f};
}

for (const key of ['', 'MySecretLanKey']) {
    const mode = key ? 'AES' : 'plaintext';
    test(`${mode}: the BidCoS port's preamble, then the module's frames pass through`, async () => {
        const {module, f} = await front(key);
        try {
            const c = new Client(f.ports.bidcos, key);
            await c.connected();
            const {hello, protocol} = await c.preamble();
            assert.ok(hello.endsWith(',SIM0000002'), hello);
            assert.equal(protocol, 'BidCoS-over-LAN-1.0');
            // a coprocessor command through the gateway: IDENTIFY answers Co_CPU_App
            c.send(encodeFrame(Buffer.from([TYPE.SYSTEM, 0x11, SYSTEM.IDENTIFY])));
            const parser = new FrameParser();
            let frame = null;
            const until = Date.now() + 2000;
            while (!frame && Date.now() < until) {
                const got = await c.bytes(1, 100).catch(() => null);
                if (got) {
                    for (const r of parser.push(got)) {
                        if (r.payload) {
                            frame = Buffer.from(r.payload);
                        }
                    }
                }
            }
            assert.ok(frame, 'a frame came back through the gateway');
            assert.deepEqual(
                [...frame.subarray(0, 4)],
                [TYPE.SYSTEM, 0x11, SYSTEM.RESPONSE_STATUS, SYSTEM_STATUS.DATA],
            );
            assert.equal(frame.subarray(4).toString('ascii'), IDENTIFY_APP);
            assert.equal(module.commands[0].name, 'IDENTIFY');
            assert.equal(
                f.trace.filter((t) => t.kind === 'bidcos' && t.line && t.line.startsWith('V')).length,
                key ? 2 : 0,
            );
            c.close();
        } finally {
            await f.close();
            module.close();
        }
    });

    test(`${mode}: the keepalive port answers L and K, checks the K counter, drops a silent client`, async () => {
        const {module, f} = await front(key);
        f.keepaliveSilenceMs = 300;
        try {
            const c = new Client(f.ports.keepalive, key);
            await c.connected();
            const {protocol} = await c.preamble();
            assert.equal(protocol, 'SysCom-1.0');
            c.sendLine('L00,02,00FF,00');
            assert.equal(await c.line(), '>L00');
            c.sendLine('K01');
            assert.equal(await c.line(), '>K01');
            c.sendLine('K02');
            assert.equal(await c.line(), '>K02');
            assert.equal(f.keepalives, 2);
            await new Promise((r) => setTimeout(r, 500));
            assert.ok(c.closed, 'dropped after the silence');
            // a wrong counter closes the connection too
            const c2 = new Client(f.ports.keepalive, key);
            await c2.connected();
            await c2.preamble();
            c2.sendLine('L00,02,00FF,00');
            await c2.line();
            c2.sendLine('K07');
            await new Promise((r) => setTimeout(r, 100));
            assert.ok(c2.closed, 'closed on the wrong counter');
        } finally {
            await f.close();
            module.close();
        }
    });
}

test('a second client on a port is refused; the hello can carry another serial once; lose and reappear', async () => {
    const {module, f} = await front('');
    try {
        const c1 = new Client(f.ports.bidcos, '');
        await c1.connected();
        await c1.preamble();
        const c2 = new Client(f.ports.bidcos, '');
        await c2.connected();
        await new Promise((r) => setTimeout(r, 100));
        assert.ok(c2.closed, 'the second client is closed');
        c1.close();
        await new Promise((r) => setTimeout(r, 50));
        f.serialOverrideOnce = 'OTHER00001';
        const c3 = new Client(f.ports.bidcos, '');
        await c3.connected();
        const {hello} = await c3.preamble();
        assert.ok(hello.endsWith(',OTHER00001'), hello);
        c3.close();
        await f.lose();
        await assert.rejects(new Client(f.ports.bidcos, '').connected(), /ECONNREFUSED/);
        await f.reappear();
        const c4 = new Client(f.ports.bidcos, '');
        await c4.connected();
        const again = await c4.preamble();
        assert.ok(again.hello.endsWith(',SIM0000002'));
        c4.close();
    } finally {
        await f.close();
        module.close();
    }
});
