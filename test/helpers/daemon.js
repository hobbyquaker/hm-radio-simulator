/**
 * Starts the daemons under test (rfd, hs485d) from the image's build, each with its own configuration in a temporary
 * directory and its own RPC port, and waits until they answer. The binaries come from HMRS_DAEMONS
 * (e.g. /opt/daemons/release or /opt/daemons/asan), the device descriptions from HMRS_RFTYPES / HMRS_HS485TYPES.
 *
 * rfd (3.89.11) does not start without a BidCoS interface ("No BidCoS-Interface available"), so startRfd() gives it a
 * simulated module on a pty unless told otherwise; the module and the pty are reachable as rfd.module and rfd.pty.
 */

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {RadioModule} from '../../lib/module.js';
import {createPtyModule} from '../../lib/pty.js';
import {createHmlangwGateway} from '../../lib/hmlangw.js';
import {BinRpcClient, XmlRpcClient, freePort} from './rpc.js';

export const DAEMONS = process.env.HMRS_DAEMONS || '';
export const RFTYPES = process.env.HMRS_RFTYPES || '/opt/openccu-base/rftypes';
export const HS485TYPES = process.env.HMRS_HS485TYPES || '/opt/openccu-base/hs485types';
export const HMLANGW = process.env.HMRS_HMLANGW || '';
export const haveDaemons = DAEMONS !== '' && fs.existsSync(path.join(DAEMONS, 'bin', 'rfd'));
export const haveHmlangw = haveDaemons && HMLANGW !== '' && fs.existsSync(HMLANGW);
export const skipWithoutDaemons = haveDaemons
    ? {}
    : {skip: 'HMRS_DAEMONS is not set: the daemon tests run in the docker image'};
export const skipWithoutHmlangw = haveHmlangw
    ? {}
    : {skip: 'HMRS_HMLANGW is not set: the LAN-gateway tests run in the docker image'};

/** The BidCoS address the test central uses (any value works; rfd only needs one that is not zero). */
export const CENTRAL_ADDRESS = 0x3a2b1c;
/** A test-only AES key, nothing a real system ever had. */
export const TEST_KEY_HEX = '00112233445566778899aabbccddeeff';

const READY_TIMEOUT_MS = Number(process.env.HMRS_READY_TIMEOUT_MS || (DAEMONS.endsWith('asan') ? 90000 : 45000));
const LOG_KEEP = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function daemonEnv(workdir) {
    return {
        ...process.env,
        LD_LIBRARY_PATH: [path.join(DAEMONS, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
        ASAN_OPTIONS:
            process.env.ASAN_OPTIONS || `detect_leaks=0:abort_on_error=1:log_path=${path.join(workdir, 'asan')}`,
        UBSAN_OPTIONS: process.env.UBSAN_OPTIONS || `print_stacktrace=1:log_path=${path.join(workdir, 'ubsan')}`,
        TZ: 'Europe/Berlin',
        // the coverage variant preloads the profile-flushing shim into the daemons only (not socat, hmlangw, node)
        ...(process.env.HMRS_DAEMON_PRELOAD ? {LD_PRELOAD: process.env.HMRS_DAEMON_PRELOAD} : {}),
    };
}

export class Daemon {
    constructor(name, bin, args, workdir, port) {
        this.name = name;
        this.bin = bin;
        this.args = args;
        this.workdir = workdir;
        this.port = port;
        /** @type {string[]} */
        this.log = [];
        this.exit = null;
        this.proc = null;
        /** @type {import('../../lib/module.js').RadioModule|null} the simulated module, when the daemon got one */
        this.module = null;
        /** @type {import('../../lib/pty.js').PtyModule|null} */
        this.pty = null;
        /** @type {import('../../lib/hmlangw.js').HmlangwGateway|null} the LAN gateway, when the daemon got one */
        this.gateway = null;
    }

    start() {
        this.proc = spawn(this.bin, this.args, {
            cwd: this.workdir,
            env: daemonEnv(this.workdir),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const logFile = fs.createWriteStream(path.join(this.workdir, `${this.name}.log`));
        const onData = (chunk) => {
            logFile.write(chunk);
            for (const line of chunk.toString().split('\n')) {
                if (line !== '') {
                    this.log.push(line);
                    if (this.log.length > LOG_KEEP) {
                        this.log.splice(0, this.log.length - LOG_KEEP);
                    }
                }
            }
        };
        this.proc.stdout.on('data', onData);
        this.proc.stderr.on('data', onData);
        this.exited = new Promise((resolve) => {
            this.proc.once('exit', (code, signal) => {
                this.exit = {code, signal, at: Date.now()};
                logFile.end();
                resolve(this.exit);
            });
        });
        this.proc.once('error', (error) => this.log.push(`spawn error: ${error.message}`));
        this.rpc = new BinRpcClient(this.port);
        this.xmlrpc = new XmlRpcClient(this.port);
        return this;
    }

    get alive() {
        return this.proc !== null && this.exit === null;
    }

    get pid() {
        return this.proc && this.proc.pid;
    }

    call(method, params, options) {
        return this.rpc.call(method, params, options);
    }

    /** Waits until the daemon answers system.listMethods, or fails with its log when it exits first. */
    async waitReady(timeout = READY_TIMEOUT_MS) {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
            if (!this.alive) {
                throw new Error(`${this.name} exited during startup (${JSON.stringify(this.exit)})\n${this.tail()}`);
            }
            try {
                await this.rpc.call('system.listMethods', [], {timeout: 2000});
                return this;
            } catch {
                await sleep(200);
            }
        }
        throw new Error(`${this.name} did not answer within ${timeout} ms\n${this.tail()}`);
    }

    tail(lines = 40) {
        return `--- ${this.name} log (last ${lines} lines) ---\n${this.log.slice(-lines).join('\n')}\n---`;
    }

    /** Lines matching a pattern, for assertions on what the daemon logged. */
    grep(pattern) {
        return this.log.filter((line) => pattern.test(line));
    }

    /** The sanitizer reports written next to the log, if any. */
    sanitizerReports() {
        return fs
            .readdirSync(this.workdir)
            .filter((f) => f.startsWith('asan.') || f.startsWith('ubsan.'))
            .map((f) => ({file: f, text: fs.readFileSync(path.join(this.workdir, f), 'utf8')}));
    }

    /** CPU ticks (user + system) the daemon has used so far, from /proc. */
    cpuTicks() {
        const stat = fs.readFileSync(`/proc/${this.pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return Number(fields[11]) + Number(fields[12]);
    }

    /** Stops the daemon, closes the RPC client (its reconnect timer would keep the test process alive) and the pty. */
    async stop() {
        if (this.alive) {
            this.proc.kill('SIGTERM');
            await Promise.race([this.exited, sleep(5000)]);
            if (this.alive) {
                this.proc.kill('SIGKILL');
                await this.exited;
            }
        }
        this.rpc.client.close();
        if (this.gateway) {
            await this.gateway.close();
            this.gateway = null;
        }
        if (this.pty) {
            await this.pty.close();
            this.pty = null;
        }
        if (this.module) {
            this.module.close();
        }
        return this.exit;
    }

    /** What the simulator side saw, for error messages. */
    simulatorView() {
        let text = '';
        if (this.module) {
            text += `\n--- module saw: ${this.module.commands.map((c) => c.name).join(' ') || 'nothing'}`;
        }
        if (this.pty) {
            text += `\n--- socat: ${this.pty.socatLog.join(' | ')}`;
        }
        if (this.gateway) {
            text += `\n--- hmlangw: ${this.gateway.lines.slice(-20).join(' | ')}`;
        }
        return text;
    }
}

/** A fresh working directory under HMRS_WORKDIR (the results volume in the image) or the temp dir. */
export function tmpdir(prefix) {
    return fs.mkdtempSync(path.join(process.env.HMRS_WORKDIR || os.tmpdir(), `${prefix}-`));
}

/**
 * An [Interface n] section of rfd.conf: `type` CCU2 / HM-MOD-UART with `dev` (the ComPortFile), or HMLGW2 with
 * `serial`, `ip` (skips the UDP search) and optionally `key` (the LAN key; empty means plaintext).
 * @typedef {{type?: string, dev?: string, serial?: string, ip?: string, key?: string}} InterfaceConfig
 */

/**
 * Writes rfd's configuration and spawns it. Without `interfaces`, a simulated module on a pty is created
 * (`module` are its options) unless `noInterface` is set, which is what rfd refuses to start with. With `lgw`, the
 * module is put behind an hmlangw LAN gateway instead and rfd gets a `Type = HMLGW2` interface (`lgw` are the
 * gateway's options, e.g. `{serial, bootloaderOnDisconnect}`; `lgw.configuredSerial` is what rfd.conf says when it
 * should differ from the gateway's).
 * @param {{interfaces?: InterfaceConfig[], module?: object, lgw?: object, noInterface?: boolean, logLevel?: number, address?: number, extra?: string}} [options]
 * @returns {Promise<Daemon>} the spawned daemon, not yet ready
 */
export async function spawnRfd({
    interfaces,
    module: moduleOptions = {},
    lgw = null,
    noInterface = false,
    logLevel = 0,
    address = CENTRAL_ADDRESS,
    extra = '',
} = {}) {
    const dir = tmpdir('hmrs-rfd');
    const port = await freePort();
    let module = null;
    let pty = null;
    let gateway = null;
    if (!interfaces && !noInterface) {
        module = new RadioModule(moduleOptions);
        if (lgw) {
            const {configuredSerial, key, ...gatewayOptions} = lgw;
            gateway = await createHmlangwGateway({module, dir, ...gatewayOptions});
            interfaces = [{type: 'HMLGW2', serial: configuredSerial ?? gateway.serial, ip: gateway.host, key}];
        } else {
            pty = await createPtyModule({module, link: path.join(dir, 'uart0')});
            interfaces = [{type: 'CCU2', dev: pty.link}];
        }
    }
    interfaces = interfaces || [];
    fs.mkdirSync(path.join(dir, 'devices'));
    fs.mkdirSync(path.join(dir, 'firmware'));
    fs.writeFileSync(path.join(dir, 'ids'), `BidCoS-Address = ${address}\n`);
    fs.writeFileSync(path.join(dir, 'keys'), `Current Index = 1\nLast Index = 1\nKey 1 = ${TEST_KEY_HEX}\n`);
    const lines = [
        'Listen IP = 127.0.0.1',
        `Listen Port = ${port}`,
        'Log Destination = Console',
        `Log Level = ${logLevel}`,
        'Log Identifier = rfd',
        'Persist Keys = 1',
        `Device Description Dir = ${RFTYPES}`,
        `Device Files Dir = ${path.join(dir, 'devices')}`,
        `Key File = ${path.join(dir, 'keys')}`,
        `Address File = ${path.join(dir, 'ids')}`,
        `Firmware Dir = ${path.join(dir, 'firmware')}`,
        `User Firmware Dir = ${path.join(dir, 'firmware')}`,
        `StatusfileDir = ${path.join(dir, 'status')}/`,
        // rfd persists its registered receivers here and re-registers them at start-up; without the key it uses
        // /var/rfd.handlers, so every later rfd in the same container would start with earlier tests' dead receivers
        `XmlRpcHandlersFile = ${path.join(dir, 'rfd.handlers')}`,
        'Fire NACK Error Events = true',
        'Improved Coprocessor Initialization = true',
        extra,
    ];
    interfaces.forEach((iface, i) => {
        lines.push(`[Interface ${i}]`, `Type = ${iface.type || 'CCU2'}`);
        if (iface.dev) {
            lines.push(`ComPortFile = ${iface.dev}`, 'AccessFile = /dev/null', 'ResetFile = /dev/null');
        }
        if (iface.serial) {
            lines.push(`Serial Number = ${iface.serial}`);
        }
        if (iface.ip) {
            lines.push(`IP Address = ${iface.ip}`);
        }
        if (iface.key !== undefined) {
            lines.push(`Encryption Key = ${iface.key}`);
        }
    });
    const config = path.join(dir, 'rfd.conf');
    fs.writeFileSync(config, lines.join('\n') + '\n');
    const daemon = new Daemon(
        'rfd',
        path.join(DAEMONS, 'bin', 'rfd'),
        ['-f', config, '-c', '-l', String(logLevel)],
        dir,
        port,
    );
    daemon.module = module;
    daemon.pty = pty;
    daemon.gateway = gateway;
    return daemon.start();
}

/**
 * spawnRfd() and wait until rfd answers; on failure the module's view is appended to the error.
 * @param {Parameters<typeof spawnRfd>[0]} [options]
 * @returns {Promise<Daemon>}
 */
export async function startRfd(options = {}) {
    for (let attempt = 0; ; attempt++) {
        const rfd = await spawnRfd(options);
        try {
            return await rfd.waitReady();
        } catch (error) {
            error.message += rfd.simulatorView();
            await rfd.stop();
            // the port was taken between the probe and rfd's bind (a race with the kernel's ephemeral ports)
            if (attempt < 2 && rfd.grep(/Could not bind to TCP port/).length > 0) {
                continue;
            }
            throw error;
        }
    }
}

/**
 * Starts hs485d against a TCP "bus" (a plain socket, the CCU1-style transport) or, with `lgw`, against a simulated
 * HMW-LGW. hs485d's XML-RPC port is fixed at 2000 unless it reads an [Interface] section, so one at a time.
 * @param {{host: string, port: number, logLevel?: number, lgw?: boolean}} options
 */
export async function startHs485d({host, port, logLevel = 0, lgw = false}) {
    const dir = tmpdir('hmrs-hs485d');
    fs.mkdirSync(path.join(dir, 'devices'));
    const config = path.join(dir, 'hs485d.conf');
    fs.writeFileSync(
        config,
        [
            'Log Destination = Console',
            `Log Level = ${logLevel}`,
            `Device Description Dir = ${HS485TYPES}`,
            `Device Files Dir = ${path.join(dir, 'devices')}`,
            `Firmware Dir = ${path.join(dir, 'firmware')}`,
            `XmlRpcHandlersFile = ${path.join(dir, 'hs485d.handlers')}`,
            '',
        ].join('\n'),
    );
    const args = ['-f', config, '-c', '-l', String(logLevel), '-h', host, '-p', String(port)];
    if (lgw) {
        args.push('-g');
    }
    const daemon = new Daemon('hs485d', path.join(DAEMONS, 'bin', 'hs485d'), args, dir, 2000);
    return daemon.start().waitReady();
}

/**
 * Runs a test body with a started daemon, prints the daemon's log tail when the body fails, and stops the daemon
 * (with its module and pty) afterwards.
 * @template T
 * @param {Daemon} daemon
 * @param {(daemon: Daemon) => Promise<T>} body
 */
export async function withDaemon(daemon, body) {
    try {
        return await body(daemon);
    } catch (error) {
        error.message += `\n${daemon.tail()}`;
        const reports = daemon.sanitizerReports();
        if (reports.length) {
            error.message += `\n--- sanitizer ---\n${reports.map((r) => r.text).join('\n')}`;
        }
        error.message += daemon.simulatorView();
        throw error;
    } finally {
        await daemon.stop();
    }
}
