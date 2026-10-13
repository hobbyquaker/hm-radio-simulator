/**
 * BidCoS-RF telegrams as the module protocol carries them: without the length byte of the air format.
 *
 *     counter | ctrl | type | src (3) | dst (3) | payload ...
 *
 * rfd's own BidcosFrame uses the same byte positions (counter at 0, ctrl at 1, type at 2, sender at 3, receiver at
 * 6, the payload from 9 - the `index` attributes of the rftypes XML count from the same origin), and the module's
 * SEND_TELEGRAM carries the telegram after two bytes of wait time and one burst byte; a received telegram follows the
 * three bytes of flags, key index and RSSI in an EVENT frame. A telegram is 9 to 26 bytes long (up to 17 payload
 * bytes).
 *
 * Public knowledge: FHEM's CUL_HM documentation and Homegear describe the frame; OpenCCU-Base's BidcosFrame.h is
 * the daemon's own definition of the fields, control bits and frame types used here.
 */

/** Control byte bits. */
export const CTRL = Object.freeze({
    RPT_ENABLE: 0x80,
    RPTED: 0x40,
    BIDI: 0x20,
    BURST: 0x10,
    BCAST: 0x04,
    WAKEMEUP: 0x02,
    WAKEUP: 0x01,
});

/** Frame types (the type byte). */
export const FT = Object.freeze({
    SYSINFO: 0x00,
    CONFIG: 0x01,
    ACK_OR_NACK: 0x02,
    AES_SOLUTION: 0x03,
    AES_CONTAINER: 0x04,
    INFO: 0x10,
    CENTRAL: 0x11,
    WAKEUP: 0x12,
    TIME: 0x3f,
    SWITCH: 0x40,
    CONDITIONAL_SWITCH: 0x41,
    LEVEL: 0x42,
    WEATHER: 0x70,
});

/** Subtypes of CONFIG frames (payload byte 1, telegram index 10). */
export const CONFIG = Object.freeze({
    CLEAR: 0x00,
    PEER_ADD: 0x01,
    PEER_REMOVE: 0x02,
    PEER_LIST_REQ: 0x03,
    PARAM_REQ: 0x04,
    START: 0x05,
    END: 0x06,
    WRITE_OFFSET: 0x07,
    WRITE_INDEX: 0x08,
    SERIAL_REQ: 0x09,
    ENTER: 0x0a,
    STATUS_REQ: 0x0e,
    DETERMINE: 0x0f,
});

/** Subtypes of ACK_OR_NACK frames (payload byte 0, telegram index 9). */
export const ACK = Object.freeze({
    ACK: 0x00,
    ACK_STATUS: 0x01,
    ACK_PARAM_IGNORED: 0x02,
    ACK_PARAM_CORRECTED: 0x03,
    ACK_W_AES_CHALLENGE: 0x04,
    NACK: 0x80,
    NACK_BUSY: 0x81,
    NACK_MEMFULL: 0x82,
    NACK_TARGET_INVALID: 0x84,
    NACK_CHANNEL_INVALID: 0x85,
});

/** Subtypes of INFO frames (payload byte 0, telegram index 9). */
export const INFO = Object.freeze({
    SERIAL: 0x00,
    PEER_LIST: 0x01,
    PARAM_RESPONSE_PAIRS: 0x02,
    PARAM_RESPONSE_SEQ: 0x03,
    PARAM_ASYNC_PAIRS: 0x04,
    PARAM_ASYNC_SEQ: 0x05,
    STATUS: 0x06,
});

export const BROADCAST = 0x000000;
export const MIN_LENGTH = 9;
export const MAX_LENGTH = 26;
/** The longest firmware update telegram: the header and a last chunk of up to 52 bytes (chosen headroom: 64). */
export const UPDATE_MAX_LENGTH = 64;

/**
 * @param {Uint8Array} bytes a telegram without the length byte
 * @returns {{counter: number, ctrl: number, type: number, src: number, dst: number, payload: Buffer}|null}
 */
export function decodeTelegram(bytes) {
    if (!bytes || bytes.length < MIN_LENGTH) {
        return null;
    }
    const b = Buffer.from(bytes);
    return {
        counter: b[0],
        ctrl: b[1],
        type: b[2],
        src: b.readUIntBE(3, 3),
        dst: b.readUIntBE(6, 3),
        payload: Buffer.from(b.subarray(9)),
    };
}

/**
 * @param {{counter?: number, ctrl?: number, flags?: number, type: number, src: number, dst?: number, payload?: ArrayLike<number>}} t
 *   `flags` is accepted as an alias of `ctrl`
 * @returns {Buffer}
 */
export function encodeTelegram(t) {
    const payload = Buffer.from(t.payload || []);
    // the firmware update frames rfd sends at 100 kbit/s are longer: 50 bytes of update data behind the header
    // (BidcosInterfaceConcentrator::SendUpdataFrame), 22 register bytes in WRITE_TRX_REG (RFDevice::set100kDataRate)
    const max = t.type === 0xca || t.type === 0xcb ? UPDATE_MAX_LENGTH : MAX_LENGTH;
    if (payload.length > max - MIN_LENGTH) {
        throw new RangeError(`payload of ${payload.length} bytes exceeds the ${max - MIN_LENGTH} a telegram holds`);
    }
    const out = Buffer.alloc(MIN_LENGTH + payload.length);
    out[0] = (t.counter ?? 0) & 0xff;
    out[1] = (t.ctrl ?? t.flags ?? 0) & 0xff;
    out[2] = t.type & 0xff;
    out.writeUIntBE(t.src & 0xffffff, 3, 3);
    out.writeUIntBE((t.dst ?? BROADCAST) & 0xffffff, 6, 3);
    out.set(payload, 9);
    return out;
}

/**
 * The telegram's byte at an rftypes `index` (counted from the counter byte, so 9 is the first payload byte).
 * @param {Uint8Array} telegram
 * @param {number} index
 */
export function byteAt(telegram, index) {
    return index < telegram.length ? telegram[index] : undefined;
}

/**
 * A short hex rendering for logs and traces: `cnt ctrl type src dst | payload`.
 * @param {Uint8Array} telegram
 */
export function formatTelegram(telegram) {
    const t = decodeTelegram(telegram);
    if (!t) {
        return Buffer.from(telegram).toString('hex');
    }
    const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');
    return `${hex(t.counter, 2)} ${hex(t.ctrl, 2)} ${hex(t.type, 2)} ${hex(t.src, 6)} ${hex(t.dst, 6)}${t.payload.length ? ' | ' + t.payload.toString('hex').toUpperCase().match(/../g).join(' ') : ''}`;
}
