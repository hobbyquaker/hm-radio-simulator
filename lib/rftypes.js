/**
 * A reader for the device descriptions rfd itself uses - the `rftypes/*.xml` files of OpenCCU-Base (HMSL 2, read from
 * the Base checkout at run time, never copied here). The simulated devices are driven by the same `<frame>` elements
 * rfd decodes with: a frame is matched by its type, its subtype at `subtype_index`, and its constant parameters; its
 * `param` parameters are extracted with the `index` (byte.bit, counted from the telegram's counter byte so 9 is the
 * first payload byte) and `size` (bytes.bits) notation of the XML.
 *
 * The XML is simple enough (elements, attributes, a little text in <docu>) for the small parser below; no dependency.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------------------------------------------
// the XML

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};

function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
        if (e[0] === '#') {
            return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
        }
        return e in ENTITIES ? ENTITIES[e] : m;
    });
}

/**
 * @typedef {{name: string, attrs: Record<string, string>, children: XmlNode[], text: string}} XmlNode
 */

/**
 * Parses an XML document into a tree. Comments, processing instructions and CDATA are skipped; attribute values may
 * use double or single quotes.
 * @param {string} text
 * @returns {XmlNode} the root element
 */
export function parseXml(text) {
    const root = {name: '#document', attrs: {}, children: [], text: ''};
    const stack = [root];
    const re =
        /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const [token, closeName, openName, attrText, selfClose, textContent] = m;
        if (
            token.startsWith('<!--') ||
            token.startsWith('<?') ||
            token.startsWith('<![CDATA[') ||
            token.startsWith('<!DOCTYPE')
        ) {
            continue;
        }
        if (closeName) {
            if (stack.length > 1) {
                stack.pop();
            }
        } else if (openName) {
            const attrs = {};
            let a;
            while ((a = attrRe.exec(attrText || '')) !== null) {
                attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
            }
            const node = {name: openName, attrs, children: [], text: ''};
            stack[stack.length - 1].children.push(node);
            if (!selfClose) {
                stack.push(node);
            }
        } else if (textContent !== undefined) {
            const t = textContent.trim();
            if (t) {
                stack[stack.length - 1].text += decodeEntities(t);
            }
        }
    }
    return root.children.find((c) => c.name) || root;
}

function child(node, name) {
    return node.children.find((c) => c.name === name);
}

function children(node, name) {
    return node.children.filter((c) => c.name === name);
}

// ---------------------------------------------------------------------------------------------------------------
// the description

/**
 * Parses "byte.bit" (e.g. "12.4", "0x15", "9") into {byte, bit}.
 * @param {string|undefined} text
 */
export function parseIndex(text, fallback = {byte: 0, bit: 0}) {
    if (text === undefined || text === '') {
        return fallback;
    }
    const [bytePart, bitPart] = String(text).split('.');
    return {byte: bytePart === '' ? 0 : Number(bytePart), bit: bitPart === undefined ? 0 : Number(bitPart)};
}

/**
 * Parses a size "bytes.bits" (e.g. "1.0", "0.3", "2") into the number of bits.
 * @param {string|undefined} text
 */
export function parseSizeBits(text, fallback = 8) {
    if (text === undefined || text === '') {
        return fallback;
    }
    const {byte, bit} = parseIndex(text);
    return byte * 8 + bit;
}

function parseNumber(text) {
    if (text === undefined || text === '') {
        return undefined;
    }
    return Number(text); // handles "0x11" and "14"
}

function parseParameter(node) {
    const index = parseIndex(node.attrs.index);
    return {
        type: node.attrs.type || 'integer',
        index: node.attrs.index === undefined ? null : index,
        sizeBits: parseSizeBits(node.attrs.size, 8),
        param: node.attrs.param || node.attrs.PARAM || null,
        constValue: parseNumber(node.attrs.const_value),
        condOp: node.attrs.cond_op || null,
        omitIf: parseNumber(node.attrs.omit_if),
    };
}

/**
 * @typedef {object} FrameDescription
 * @property {string} id
 * @property {'to_device'|'from_device'} direction
 * @property {number} type
 * @property {number|null} subtype
 * @property {number} subtypeIndex
 * @property {{byte: number, bit: number, bits: number}|null} channelField
 * @property {number|null} fixedChannel null, a number, or -1 for "*"
 * @property {boolean} event
 * @property {Array<ReturnType<typeof parseParameter>>} parameters
 */

function parseFrame(node) {
    let channelField = null;
    if (node.attrs.channel_field !== undefined) {
        // "10" or "9:0.6" (byte, then bit start and bit size)
        const [bytePart, bitsPart] = node.attrs.channel_field.split(':');
        const bits = bitsPart ? bitsPart.split('.') : null;
        channelField = {
            byte: Number(bytePart),
            bit: bits ? Number(bits[0]) : 0,
            bits: bits ? Number(bits[1]) : 8,
        };
    }
    return {
        id: node.attrs.id,
        direction: node.attrs.direction,
        type: parseNumber(node.attrs.type),
        subtype: parseNumber(node.attrs.subtype) ?? null,
        subtypeIndex: parseNumber(node.attrs.subtype_index) ?? 9,
        channelField,
        fixedChannel:
            node.attrs.fixed_channel === undefined
                ? null
                : node.attrs.fixed_channel === '*'
                  ? -1
                  : Number(node.attrs.fixed_channel),
        event: node.attrs.event === 'true',
        allowedReceivers: node.attrs.allowed_receivers || null,
        parameters: children(node, 'parameter').map(parseParameter),
    };
}

/**
 * Collects the config parameters (interface="config") of a paramset into {id -> {list, byte, bit, bits}} resolving
 * `<subset ref>` against paramset_defs.
 */
function collectConfigParams(paramsetNode, defs) {
    const result = {};
    const visit = (node) => {
        for (const sub of children(node, 'subset')) {
            const def = defs.get(sub.attrs.ref);
            if (def) {
                visit(def);
            }
        }
        for (const p of children(node, 'parameter')) {
            const physical = child(p, 'physical');
            if (physical && physical.attrs.interface === 'config') {
                const index = parseIndex(physical.attrs.index);
                result[p.attrs.id] = {
                    list: Number(physical.attrs.list || 0),
                    byte: index.byte,
                    bit: index.bit,
                    bits: parseSizeBits(physical.attrs.size, 8),
                };
            }
        }
    };
    visit(paramsetNode);
    return result;
}

/**
 * Loads one device description.
 * @param {string} file path of an rftypes XML file
 */
export function loadDeviceDescription(file) {
    const text = fs.readFileSync(file).toString('latin1');
    const root = parseXml(text);
    const defs = new Map();
    const defsNode = child(root, 'paramset_defs');
    if (defsNode) {
        for (const ps of children(defsNode, 'paramset')) {
            defs.set(ps.attrs.id, ps);
        }
    }
    const types = children(child(root, 'supported_types') || {children: []}, 'type').map((t) => ({
        id: t.attrs.id,
        name: t.attrs.name,
        priority: Number(t.attrs.priority || 0),
        conditions: children(t, 'parameter').map(parseParameter),
    }));
    const channelsNode = child(root, 'channels') || {children: []};
    const channels = children(channelsNode, 'channel').map((c) => {
        const paramsets = {};
        for (const ps of children(c, 'paramset')) {
            paramsets[ps.attrs.type] = {id: ps.attrs.id, config: collectConfigParams(ps, defs)};
        }
        return {
            index: Number(c.attrs.index),
            type: c.attrs.type,
            count: c.attrs.count === undefined ? 1 : Number(c.attrs.count),
            countFromSysinfo: c.attrs.count_from_sysinfo || null,
            hidden: c.attrs.hidden === 'true',
            paramsets,
        };
    });
    const deviceParamsets = {};
    for (const ps of children(root, 'paramset')) {
        deviceParamsets[ps.attrs.type] = {id: ps.attrs.id, config: collectConfigParams(ps, defs)};
    }
    const frames = children(child(root, 'frames') || {children: []}, 'frame').map(parseFrame);
    return {
        file: path.basename(file),
        version: Number(root.attrs.version || 0),
        supportsAes: root.attrs.supports_aes === 'true',
        rxModes: root.attrs.rx_modes || 'ALWAYS',
        peeringSysinfoExpectChannel: root.attrs.peering_sysinfo_expect_channel !== 'false',
        types,
        channels,
        paramsets: deviceParamsets,
        frames,
    };
}

/**
 * The sysinfo values that make rfd pick a type: the firmware byte (index 9) and the two type bytes (index 10, 11).
 * @param {ReturnType<typeof loadDeviceDescription>} description
 * @param {string} typeId e.g. "HM-LC-Sw1-Pl"
 * @returns {{firmware: number, type: number}}
 */
export function sysinfoForType(description, typeId) {
    const type = description.types.find((t) => t.id === typeId);
    if (!type) {
        throw new Error(
            `type ${typeId} is not in ${description.file}: ${description.types.map((t) => t.id).join(', ')}`,
        );
    }
    let firmware = 0x10;
    let typeCode = 0;
    for (const c of type.conditions) {
        if (!c.index) {
            continue;
        }
        if (c.index.byte === 9) {
            firmware =
                c.condOp === 'GE' ? c.constValue : c.condOp === 'LE' ? Math.min(firmware, c.constValue) : c.constValue;
        } else if (c.index.byte === 10 && c.sizeBits === 16) {
            typeCode = c.constValue;
        }
    }
    return {firmware, type: typeCode};
}

// ---------------------------------------------------------------------------------------------------------------
// bit fields in telegrams

/**
 * Reads a field of `bits` bits starting at byte `byte`, bit `bit` (lsb first within a byte, big-endian across bytes
 * as rfd's StructuredFrame does: whole bytes are big-endian, a sub-byte field is masked at `bit`).
 * @param {Uint8Array} telegram
 */
export function readField(telegram, byte, bit, bits) {
    if (bits >= 8 && bit === 0) {
        let value = 0;
        for (let i = 0; i < bits / 8; i++) {
            value = value * 256 + (telegram[byte + i] ?? 0);
        }
        return value;
    }
    return ((telegram[byte] ?? 0) >> bit) & ((1 << bits) - 1);
}

/**
 * @param {Buffer} telegram grown as needed
 */
export function writeField(telegram, byte, bit, bits, value) {
    const needed = byte + Math.max(1, Math.ceil(bits / 8));
    let out = telegram;
    if (out.length < needed) {
        out = Buffer.concat([out, Buffer.alloc(needed - out.length)]);
    }
    if (bits >= 8 && bit === 0) {
        const count = bits / 8;
        for (let i = count - 1; i >= 0; i--) {
            out[byte + i] = value & 0xff;
            value = Math.floor(value / 256);
        }
    } else {
        const mask = ((1 << bits) - 1) << bit;
        out[byte] = (out[byte] & ~mask) | ((value << bit) & mask);
    }
    return out;
}

/**
 * Finds the frame description a telegram matches and extracts its parameters.
 * @param {ReturnType<typeof loadDeviceDescription>} description
 * @param {Uint8Array} telegram
 * @param {'to_device'|'from_device'} direction
 * @returns {{frame: FrameDescription, channel: number|null, values: Record<string, number>}|null}
 */
export function matchFrame(description, telegram, direction) {
    const type = telegram[2];
    for (const frame of description.frames) {
        if (frame.direction !== direction || frame.type !== type) {
            continue;
        }
        if (frame.subtype !== null && telegram[frame.subtypeIndex] !== frame.subtype) {
            continue;
        }
        let ok = true;
        const values = {};
        for (const p of frame.parameters) {
            if (!p.index) {
                continue;
            }
            const value = readField(telegram, p.index.byte, p.index.bit, p.sizeBits);
            if (p.constValue !== undefined && p.param === null) {
                if (value !== p.constValue) {
                    ok = false;
                    break;
                }
            } else if (p.param) {
                values[p.param] = value;
            }
        }
        if (!ok) {
            continue;
        }
        let channel = null;
        if (frame.channelField) {
            channel = readField(telegram, frame.channelField.byte, frame.channelField.bit, frame.channelField.bits);
        } else if (frame.fixedChannel !== null) {
            channel = frame.fixedChannel;
        }
        return {frame, channel, values};
    }
    return null;
}

/**
 * Builds the payload (from telegram index 9) of a frame from its description.
 * @param {FrameDescription} frame
 * @param {{channel?: number, values?: Record<string, number>}} options
 * @returns {Buffer} the payload bytes
 */
export function buildFramePayload(frame, {channel = 0, values = {}} = {}) {
    let telegram = Buffer.alloc(9);
    if (frame.subtype !== null) {
        telegram = writeField(telegram, frame.subtypeIndex, 0, 8, frame.subtype);
    }
    if (frame.channelField) {
        telegram = writeField(
            telegram,
            frame.channelField.byte,
            frame.channelField.bit,
            frame.channelField.bits,
            channel,
        );
    }
    for (const p of frame.parameters) {
        if (!p.index) {
            continue;
        }
        let value;
        if (p.param && values[p.param] !== undefined) {
            value = values[p.param];
        } else if (p.constValue !== undefined) {
            value = p.constValue;
        } else {
            value = 0;
        }
        if (p.omitIf !== undefined && value === p.omitIf) {
            continue;
        }
        telegram = writeField(telegram, p.index.byte, p.index.bit, p.sizeBits, value);
    }
    return Buffer.from(telegram.subarray(9));
}

/**
 * @param {ReturnType<typeof loadDeviceDescription>} description
 * @param {string} id
 */
export function frameById(description, id) {
    const frame = description.frames.find((f) => f.id === id);
    if (!frame) {
        throw new Error(`frame ${id} is not in ${description.file}`);
    }
    return frame;
}
