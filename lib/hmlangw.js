/**
 * The LAN-gateway attachment with hmlangw (MIT, the HM-LGW emulation for the HM-MOD-RPI from the OpenCCU project) as
 * the front: hmlangw listens on the HM-LGW ports 2000 (BidCoS, after the text preamble a transparent relay of the
 * module frames) and 2001 (keepalive, `L`/`K` lines) and talks to the simulated module through the socat pty of
 * `pty.js`. rfd connects with `Type = HMLGW2`, `IP Address = 127.0.0.1`. This is also openccu-lite's HM-LGW mode.
 *
 *     hmlangw -b -n <serial> -s <pty link> -r -1 -l 127.0.0.1 -D
 *
 * `-b` keeps hmlangw from parking the module in the bootloader whenever no client is connected (the production
 * setting); without it the module is sent STARTBOOTLOADER on every disconnect and must answer with the identify
 * announcement hmlangw expects (`RadioModule` does). The ports are fixed in rfd, so one gateway at a time per network
 * namespace. Killing hmlangw is "gateway lost": rfd's two TCP connections die and its reconnect machinery starts.
 *
 * hmlangw 1.1.1's debug output (`-D`) crashes in sendEnterBootloader(): the fprintf there has its arguments swapped
 * (the fd as `%s`), so the debug flag is only used together with `-b`, where that function returns early. hmlangw
 * also starts its threads with SCHED_RR, which needs CAP_SYS_NICE (`docker run --cap-add SYS_NICE`).
 */

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {createPtyModule} from './pty.js';

export const LGW_BIDCOS_PORT = 2000;
export const LGW_KEEPALIVE_PORT = 2001;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {number} port
 * @returns {boolean} whether something listens on that TCP port (from /proc/net/tcp*)
 */
export function portIsListening(port) {
    const hex = port.toString(16).toUpperCase().padStart(4, '0');
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        for (const line of text.split('\n').slice(1)) {
            const fields = line.trim().split(/\s+/);
            if (fields.length > 3 && fields[1].endsWith(`:${hex}`) && fields[3] === '0A') {
                return true;
            }
        }
    }
    return false;
}

/**
 * Starts the pty module and hmlangw in front of it.
 * @param {{module: import('./module.js').RadioModule, dir: string, serial?: string, bin?: string, listen?: string,
 *   bootloaderOnDisconnect?: boolean, socat?: string, log?: (line: string) => void}} options
 * @returns {Promise<HmlangwGateway>}
 */
export async function createHmlangwGateway(options) {
    const gateway = new HmlangwGateway(options);
    await gateway.start();
    return gateway;
}

export class HmlangwGateway {
    constructor({
        module,
        dir,
        serial = module.serial,
        bin = process.env.HMRS_HMLANGW || 'hmlangw',
        listen = '127.0.0.1',
        bootloaderOnDisconnect = false,
        socat = 'socat',
        log = () => {},
    }) {
        this.module = module;
        this.dir = dir;
        this.serial = serial;
        this.bin = bin;
        this.listen = listen;
        this.bootloaderOnDisconnect = bootloaderOnDisconnect;
        this.socat = socat;
        this.log = log;
        this.pty = null;
        this.child = null;
        /** @type {string[]} hmlangw's stderr, one entry per line */
        this.lines = [];
        /** @type {Array<{at: number, port: number}>} client connections hmlangw reported */
        this.connections = [];
        this.starts = 0;
    }

    get host() {
        return this.listen;
    }

    async start() {
        this.pty = await createPtyModule({
            module: this.module,
            link: path.join(this.dir, 'lgw-uart'),
            socat: this.socat,
            log: this.log,
        });
        await this.spawn();
    }

    async spawn() {
        if (portIsListening(LGW_BIDCOS_PORT) || portIsListening(LGW_KEEPALIVE_PORT)) {
            throw new Error(`ports ${LGW_BIDCOS_PORT}/${LGW_KEEPALIVE_PORT} are taken: another gateway or hs485d?`);
        }
        const args = ['-n', this.serial, '-s', this.pty.link, '-r', '-1', '-l', this.listen];
        if (!this.bootloaderOnDisconnect) {
            args.unshift('-b', '-D'); // -D only with -b, see above
        }
        const child = spawn(this.bin, args, {stdio: ['ignore', 'pipe', 'pipe']});
        this.child = child;
        this.starts++;
        const onData = (chunk) => {
            for (const line of chunk.toString().split('\n')) {
                if (line.trim() === '') {
                    continue;
                }
                this.lines.push(line);
                this.log(`hmlangw: ${line}`);
                const m = /connected to (BidCos|keepalive) port/.exec(line);
                if (m) {
                    this.connections.push({
                        at: Date.now(),
                        port: m[1] === 'BidCos' ? LGW_BIDCOS_PORT : LGW_KEEPALIVE_PORT,
                    });
                }
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        this.exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({code, signal})));
        child.once('error', (error) => this.lines.push(`spawn error: ${error.message}`));
        const until = Date.now() + 10000;
        while (Date.now() < until) {
            if (child.exitCode !== null || child.signalCode !== null) {
                const hint =
                    child.exitCode === 1 && !this.lines.some((l) => /Can't|ERROR|missing/.test(l))
                        ? ' - hmlangw starts its threads with SCHED_RR; in docker that needs --cap-add SYS_NICE'
                        : '';
                throw new Error(
                    `hmlangw exited at start (${child.exitCode ?? child.signalCode})${hint}:\n${this.lines.join('\n')}`,
                );
            }
            if (portIsListening(LGW_BIDCOS_PORT) && portIsListening(LGW_KEEPALIVE_PORT)) {
                return;
            }
            await sleep(20);
        }
        throw new Error(
            `hmlangw did not open ports ${LGW_BIDCOS_PORT}/${LGW_KEEPALIVE_PORT}:\n${this.lines.join('\n')}`,
        );
    }

    get alive() {
        return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
    }

    /** Lines of hmlangw's log matching a pattern. */
    grep(pattern) {
        return this.lines.filter((line) => pattern.test(line));
    }

    /** Kills hmlangw: the gateway is gone, rfd's connections on 2000 and 2001 die. */
    async lose() {
        if (!this.alive) {
            return;
        }
        this.child.kill('SIGTERM');
        await Promise.race([this.exited, sleep(2000)]);
        if (this.alive) {
            this.child.kill('SIGKILL');
            await this.exited;
        }
        const until = Date.now() + 5000;
        while ((portIsListening(LGW_BIDCOS_PORT) || portIsListening(LGW_KEEPALIVE_PORT)) && Date.now() < until) {
            await sleep(20);
        }
    }

    /** The gateway is back: hmlangw starts again on the same module (socat is respawned when it went down too). */
    async reappear() {
        await this.lose();
        if (this.pty.child.exitCode !== null || this.pty.child.signalCode !== null) {
            await this.pty.reappear();
        }
        await this.spawn();
    }

    async close() {
        await this.lose();
        if (this.pty) {
            await this.pty.close();
            this.pty = null;
        }
    }
}
