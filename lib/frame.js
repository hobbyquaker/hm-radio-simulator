/**
 * The serial framing between rfd and its BidCoS radio module (HM-MOD-RPI-PCB, RPI-RF-MOD in legacy mode,
 * HM-LGW over TCP):
 *
 *     FD | len_hi len_lo | payload ... | crc_hi crc_lo
 *
 * The length counts the payload bytes. The CRC is CRC-16 with the polynomial 0x8005 and the initial value 0xFFFF
 * over the length and payload bytes (everything after the start byte). After the start byte every 0xFD and 0xFC is
 * escaped as 0xFC followed by the byte with bit 7 cleared.
 *
 * The parser mirrors the daemon's reassembly: a start byte inside a frame drops the frame so far, an escape applies
 * to the next byte, the expected size is known after the two length bytes, and a frame whose CRC does not match is
 * reported as an error, never delivered.
 *
 * Public knowledge: the framing is documented in FHEM's HMUARTLGW module, Homegear's Hm-Mod-Rpi-Pcb interface and
 * hmgo's uartgw package, and it is what OpenCCU-Base's rfd implements in its CCU2SerialFrame class.
 */

export const FRAME_START = 0xfd;
export const ESCAPE = 0xfc;
const CRC_POLY = 0x8005;
const OVERHEAD = 5; // start, two length bytes, two CRC bytes

/**
 * CRC-16/0x8005, MSB first, initial value 0xFFFF, no final XOR.
 * @param {Uint8Array} bytes
 * @param {number} [init]
 * @returns {number}
 */
export function crc16(bytes, init = 0xffff) {
    let crc = init;
    for (const byte of bytes) {
        let value = byte;
        for (let i = 0; i < 8; i++) {
            if (((crc & 0x8000) >> 8) ^ (value & 0x80)) {
                crc = ((crc << 1) ^ CRC_POLY) & 0xffff;
            } else {
                crc = (crc << 1) & 0xffff;
            }
            value = (value << 1) & 0xff;
        }
    }
    return crc;
}

/**
 * Escapes everything after the start byte.
 * @param {Uint8Array} raw an unescaped frame starting with FRAME_START
 * @returns {Buffer}
 */
export function escapeFrame(raw) {
    const out = [raw[0]];
    for (let i = 1; i < raw.length; i++) {
        const byte = raw[i];
        if (byte === FRAME_START || byte === ESCAPE) {
            out.push(ESCAPE, byte & 0x7f);
        } else {
            out.push(byte);
        }
    }
    return Buffer.from(out);
}

/**
 * Builds a complete, escaped frame around a payload.
 * @param {Uint8Array} payload
 * @returns {Buffer}
 */
export function encodeFrame(payload) {
    if (payload.length > 0xffff) {
        throw new RangeError('payload too long for a 16-bit length');
    }
    const raw = Buffer.alloc(payload.length + OVERHEAD);
    raw[0] = FRAME_START;
    raw[1] = (payload.length >> 8) & 0xff;
    raw[2] = payload.length & 0xff;
    raw.set(payload, 3);
    const crc = crc16(raw.subarray(1, 3 + payload.length));
    raw[3 + payload.length] = (crc >> 8) & 0xff;
    raw[4 + payload.length] = crc & 0xff;
    return escapeFrame(raw);
}

/**
 * Incremental frame parser. Feed it chunks of any size; it returns the frames and errors found so far.
 */
export class FrameParser {
    constructor() {
        this.reset();
        this.stats = {frames: 0, crcErrors: 0, restarts: 0, noise: 0};
    }

    reset() {
        /** @type {number[]} */
        this.buffer = [];
        this.expected = -1;
        this.escapePending = false;
    }

    /**
     * @param {Uint8Array} chunk
     * @returns {Array<{payload?: Buffer, error?: string, raw?: Buffer}>}
     */
    push(chunk) {
        const results = [];
        for (const byte of chunk) {
            if (byte === FRAME_START) {
                if (this.buffer.length > 0) {
                    this.stats.restarts++;
                    results.push({error: 'restart', raw: Buffer.from(this.buffer)});
                }
                this.reset();
                this.buffer.push(byte);
                continue;
            }
            if (byte === ESCAPE) {
                this.escapePending = true;
                continue;
            }
            let value = byte;
            if (this.escapePending) {
                value |= 0x80;
                this.escapePending = false;
            }
            if (this.buffer.length === 0) {
                this.stats.noise++;
                results.push({error: 'noise', raw: Buffer.from([byte])});
                continue;
            }
            this.buffer.push(value);
            if (this.buffer.length === 3) {
                this.expected = ((this.buffer[1] << 8) | this.buffer[2]) + OVERHEAD;
            }
            if (this.expected !== -1 && this.buffer.length >= this.expected) {
                const raw = Buffer.from(this.buffer);
                const crc = crc16(raw.subarray(1, raw.length - 2));
                const got = (raw[raw.length - 2] << 8) | raw[raw.length - 1];
                if (crc === got) {
                    this.stats.frames++;
                    results.push({payload: raw.subarray(3, raw.length - 2)});
                } else {
                    this.stats.crcErrors++;
                    results.push({error: 'crc', raw});
                }
                this.reset();
            }
        }
        return results;
    }
}
