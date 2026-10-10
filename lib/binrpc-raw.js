/**
 * A raw BIN-RPC encoder: enough of the wire format to build valid requests for fuzz seeds and - the point of it -
 * deliberately broken ones for the robustness tests, which no well-behaved client library will produce.
 *
 *     'Bin' | msg type | body length (4) | body
 *     request body: method length (4) | method | parameter count (4) | parameters
 *     value: type (4) | ...   int 0x01, bool 0x02, string 0x03, double 0x04, array 0x100, struct 0x101
 */

export const MSG = Object.freeze({
    REQUEST: 0x00,
    RESPONSE: 0x01,
    REQUEST_WITH_HEADER: 0x40,
    RESPONSE_WITH_HEADER: 0x41,
    FAULT: 0xff,
});
export const BT = Object.freeze({INT: 0x01, BOOL: 0x02, STRING: 0x03, DOUBLE: 0x04, ARRAY: 0x100, STRUCT: 0x101});

/** @param {number} n */
export function u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0, 0);
    return b;
}

/** @param {number} n */
export function i32(n) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n | 0, 0);
    return b;
}

/**
 * Encodes a JavaScript value: number (integer or {double}), boolean, string, array, plain object (struct).
 * @param {*} value
 * @returns {Buffer}
 */
export function encodeValue(value) {
    if (typeof value === 'boolean') {
        return Buffer.concat([u32(BT.BOOL), Buffer.from([value ? 1 : 0])]);
    }
    if (typeof value === 'number') {
        if (Number.isInteger(value)) {
            return Buffer.concat([u32(BT.INT), i32(value)]);
        }
        return encodeDouble(value);
    }
    if (typeof value === 'string') {
        const s = Buffer.from(value, 'latin1');
        return Buffer.concat([u32(BT.STRING), u32(s.length), s]);
    }
    if (Array.isArray(value)) {
        return Buffer.concat([u32(BT.ARRAY), u32(value.length), ...value.map(encodeValue)]);
    }
    if (value && typeof value === 'object') {
        if ('double' in value && Object.keys(value).length === 1) {
            return encodeDouble(value.double);
        }
        const entries = Object.entries(value);
        const parts = [u32(BT.STRUCT), u32(entries.length)];
        for (const [key, member] of entries) {
            const k = Buffer.from(key, 'latin1');
            parts.push(u32(k.length), k, encodeValue(member));
        }
        return Buffer.concat(parts);
    }
    throw new TypeError(`cannot encode ${typeof value}`);
}

/** BIN-RPC doubles: mantissa as a signed 32-bit fraction of 2^30, exponent as a signed 32-bit integer. */
export function encodeDouble(value) {
    let exponent = 0;
    let mantissa = 0;
    if (value !== 0) {
        exponent = Math.floor(Math.log2(Math.abs(value))) + 1;
        mantissa = Math.round((value / 2 ** exponent) * 2 ** 30);
    }
    return Buffer.concat([u32(BT.DOUBLE), i32(mantissa), i32(exponent)]);
}

/**
 * @param {string} method
 * @param {Array<*>} params
 * @returns {Buffer}
 */
export function encodeRequest(method, params = []) {
    const m = Buffer.from(method, 'latin1');
    const body = Buffer.concat([u32(m.length), m, u32(params.length), ...params.map(encodeValue)]);
    return Buffer.concat([Buffer.from('Bin', 'ascii'), Buffer.from([MSG.REQUEST]), u32(body.length), body]);
}

/**
 * @param {*} value
 * @returns {Buffer}
 */
export function encodeResponse(value) {
    const body = encodeValue(value);
    return Buffer.concat([Buffer.from('Bin', 'ascii'), Buffer.from([MSG.RESPONSE]), u32(body.length), body]);
}

/**
 * Wraps an arbitrary body as a request message with the given declared length (default: the real one), for
 * messages whose declared and real lengths disagree.
 * @param {Buffer} body
 * @param {number} [declaredLength]
 */
export function rawMessage(body, declaredLength = body.length) {
    return Buffer.concat([Buffer.from('Bin', 'ascii'), Buffer.from([MSG.REQUEST]), u32(declaredLength), body]);
}

/**
 * The malformed requests the robustness tests send: each is a message whose outer header is well formed and whose
 * body lies about a length or ends early.
 * @returns {Array<{name: string, bytes: Buffer, mayWait?: boolean}>} mayWait: the daemon may keep the connection open
 *   waiting for more bytes instead of answering or closing
 */
export function malformedRequests() {
    const method = (name) => Buffer.concat([u32(name.length), Buffer.from(name, 'latin1')]);
    return [
        {
            // a struct whose member name claims to be almost 4 GiB long
            name: 'struct member-name length 0xFFFFFFF0',
            bytes: rawMessage(
                Buffer.concat([
                    method('setValue'),
                    u32(1),
                    u32(BT.STRUCT),
                    u32(1),
                    u32(0xfffffff0),
                    Buffer.from('ab'),
                    encodeValue(1),
                ]),
            ),
        },
        {
            name: 'string length 0xFFFFFFFF',
            bytes: rawMessage(
                Buffer.concat([method('getValue'), u32(2), u32(BT.STRING), u32(0xffffffff), Buffer.from('x')]),
            ),
        },
        {
            name: 'truncated integer',
            bytes: rawMessage(Buffer.concat([method('getValue'), u32(1), u32(BT.INT), Buffer.from([0x00, 0x01])])),
        },
        {
            name: 'array count 0x7FFFFFFF with one element',
            bytes: rawMessage(
                Buffer.concat([method('system.multicall'), u32(1), u32(BT.ARRAY), u32(0x7fffffff), encodeValue(1)]),
            ),
        },
        {
            name: 'parameter count larger than the body',
            bytes: rawMessage(Buffer.concat([method('listDevices'), u32(1000)])),
        },
        {
            name: 'method-name length beyond the body',
            bytes: rawMessage(Buffer.concat([u32(0x40000000), Buffer.from('listDevices'), u32(0)])),
        },
        {
            // a server is entitled to wait for the rest of such a body instead of answering
            name: 'declared body length far beyond the real one',
            bytes: rawMessage(Buffer.concat([method('listDevices'), u32(0)]), 0x7ffffff0),
            mayWait: true,
        },
        {
            name: 'unknown value type',
            bytes: rawMessage(Buffer.concat([method('getValue'), u32(1), u32(0x4242), u32(0)])),
        },
        {
            name: 'empty body',
            bytes: rawMessage(Buffer.alloc(0)),
        },
    ];
}
