/**
 * The UART attachment: a pseudo-terminal the daemon opens as its ComPortFile, bridged by socat to a local TCP port
 * where the simulated module listens. Node has no pty in its standard library; socat (in the test image) makes the
 * device node, and the module stays pure JavaScript.
 *
 *     socat PTY,link=<link>,raw,echo=0,wait-slave,pty-interval=0.02 TCP:127.0.0.1:<port>
 *
 * `wait-slave` makes socat connect only when the daemon opens the slave side - the module "is there" from the
 * daemon's first byte. socat notices the opened slave by polling, every 1 s by default (`pty-interval`): rfd's first
 * command (IDENTIFY) has a 1 s answer window, so a late poll made rfd give the module up at start now and then
 * (seen once in a full gate run) - the interval is 20 ms here. Killing socat hangs the pty up: the daemon's read()
 * fails, which is the "module lost" case.
 */

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, what) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (await predicate()) {
            return;
        }
        await sleep(20);
    }
    throw new Error(`timeout waiting for ${what}`);
}

/**
 * Starts a TCP listener for the module and a socat that exposes it as a pty.
 * @param {{module: import('./module.js').RadioModule, link: string, socat?: string, log?: (line: string) => void}} options
 * @returns {Promise<PtyModule>}
 */
export async function createPtyModule({module, link, socat = 'socat', log = () => {}}) {
    const pty = new PtyModule(module, link, socat, log);
    await pty.start();
    return pty;
}

export class PtyModule {
    constructor(module, link, socat, log) {
        this.module = module;
        this.link = link;
        this.socat = socat;
        this.log = log;
        this.server = null;
        this.port = 0;
        this.child = null;
        this.socket = null;
        this.socatLog = [];
    }

    async start() {
        this.server = net.createServer((socket) => {
            this.socket = socket;
            socket.setNoDelay(true);
            this.module.attach(socket);
            socket.on('close', () => {
                if (this.socket === socket) {
                    this.socket = null;
                }
            });
        });
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => resolve());
        });
        this.port = this.server.address().port;
        await this.spawnSocat();
    }

    async spawnSocat() {
        try {
            fs.unlinkSync(this.link);
        } catch {
            // no stale link
        }
        const args = [
            '-d',
            '-d',
            `PTY,link=${this.link},raw,echo=0,wait-slave,pty-interval=0.02`,
            `TCP:127.0.0.1:${this.port}`,
        ];
        const child = spawn(this.socat, args, {stdio: ['ignore', 'pipe', 'pipe']});
        this.child = child;
        const onLine = (chunk) => {
            for (const line of chunk.toString().split('\n')) {
                if (line.trim()) {
                    this.socatLog.push(line);
                    this.log(`socat: ${line}`);
                }
            }
        };
        child.stdout.on('data', onLine);
        child.stderr.on('data', onLine);
        this.exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({code, signal})));
        child.once('error', (error) => this.log(`socat: ${error.message}`));
        await waitFor(() => fs.existsSync(this.link), 5000, `pty link ${this.link}`);
    }

    /** Kills socat: the daemon's side of the pty hangs up. */
    async lose() {
        if (!this.child || this.child.exitCode !== null) {
            return;
        }
        this.child.kill('SIGTERM');
        await Promise.race([this.exited, sleep(2000)]);
        if (this.child.exitCode === null) {
            this.child.kill('SIGKILL');
            await this.exited;
        }
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    /** A new socat on the same link: the module is back (the daemon has to reopen the device). */
    async reappear() {
        await this.lose();
        await this.spawnSocat();
    }

    async close() {
        await this.lose();
        await new Promise((resolve) => this.server.close(() => resolve()));
        try {
            fs.unlinkSync(this.link);
        } catch {
            // already gone
        }
    }
}
