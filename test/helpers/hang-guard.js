/**
 * Fails a test file that would otherwise hang after its last test. On 2026-10-10 hs485d-lgw.test.js ran for 20 hours:
 * its last test had passed, something kept the process alive, and `node --test` waits for a file's process for ever -
 * a per-test timeout (every daemon test has one) does not help once the tests are over, and a timed-out test leaves
 * its daemons running because its withDaemon() finally never runs.
 *
 * So, after the last test of a file (node:test's root `after` hook, registered by test/helpers/daemon.js for every
 * daemon test): daemons still alive are stopped and named, then an unreferenced timer gives the process
 * HMRS_HANG_GRACE_MS (default 30 s) to end on its own - it does not keep the process alive itself. If the process is
 * still there when it fires, the guard prints the open handles and exits with 1, which `node --test` reports as the
 * file's failure instead of waiting.
 */
import {after} from 'node:test';

const GRACE_MS = Number(process.env.HMRS_HANG_GRACE_MS || 30000);

/** @type {Set<{name: string, pid: number|null, alive: boolean, stop: () => Promise<unknown>}>} */
const daemons = new Set();

/** @param {{name: string, pid: number|null, alive: boolean, stop: () => Promise<unknown>}} daemon */
export function track(daemon) {
    daemons.add(daemon);
}

/** @param {{name: string, pid: number|null, alive: boolean, stop: () => Promise<unknown>}} daemon */
export function untrack(daemon) {
    daemons.delete(daemon);
}

/** The daemons started through track() and not stopped yet. */
export function tracked() {
    return [...daemons];
}

after(
    async () => {
        const leaked = [...daemons].filter((d) => d.alive);
        for (const d of leaked) {
            console.error(`hang guard: ${d.name} (pid ${d.pid}) is still running after the last test - stopping it`);
            await d.stop();
        }
        daemons.clear();
        setTimeout(() => {
            console.error(
                `hang guard: the test process is still alive ${GRACE_MS} ms after its last test; open handles: ${process
                    .getActiveResourcesInfo()
                    .join(', ')} - exiting with 1`,
            );
            process.exit(1);
        }, GRACE_MS).unref();
    },
    {timeout: 120000},
);
