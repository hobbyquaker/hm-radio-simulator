/**
 * A small seeded generator (mulberry32) so that fuzz-like tests are reproducible from their logged seed.
 */

/**
 * @param {number} seed
 * @returns {{seed: number, next(): number, int(max: number): number, byte(): number, bytes(n: number): Buffer, pick<T>(items: T[]): T}}
 */
export function mulberry32(seed) {
    let state = seed >>> 0;
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        seed,
        next,
        int: (max) => Math.floor(next() * max),
        byte: () => Math.floor(next() * 256),
        bytes(n) {
            const out = Buffer.alloc(n);
            for (let i = 0; i < n; i++) {
                out[i] = Math.floor(next() * 256);
            }
            return out;
        },
        pick: (items) => items[Math.floor(next() * items.length)],
    };
}

/**
 * The seed for a test run: HMRS_SEED if set, otherwise derived from the clock (and to be logged).
 * @returns {number}
 */
export function seedFromEnvironment() {
    const fromEnv = process.env.HMRS_SEED;
    if (fromEnv !== undefined && fromEnv !== '') {
        return Number.parseInt(fromEnv, 10) >>> 0;
    }
    return (Date.now() ^ (process.pid << 8)) >>> 0;
}
