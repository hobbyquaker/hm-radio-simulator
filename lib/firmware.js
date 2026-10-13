/**
 * Firmware files as the daemons read them, for the update tests: the `.eq3` update file of a BidCoS device
 * (libelvutils `UpdateFile`), the Intel HEX file of a wired device (libelvutils `Hexfile`), and the `fwmap` and
 * `info` files that name them (rfd's `RFFirmwareManager`, hs485d's `HS485FirmwareManager`).
 *
 * The `.eq3` layout is what `UpdateFile::Read` parses: one frame after another without separators, each frame four
 * hex characters of length (big-endian) followed by 2 × length hex characters; the frame rfd sends to the device is
 * the two length bytes plus the data. What the data holds is the device's business (rfd never looks inside), so the
 * synthetic frames here carry what the simulated bootloader checks - **chosen**, not read from any firmware:
 *
 *     frame 0:  type (2, big-endian) | firmware byte | frame count | filler ... | CRC-16 (2)
 *     frame n:  filler ...                                                      | CRC-16 (2)
 *
 * The CRC is CRC-16 with the polynomial 0x8005 and the initial value 0xFFFF over the frame's data, appended so that
 * the whole frame checks to 0 - the check that `UpdateFile::Read` carries in commented-out form (`Crc16
 * crcCheck(0xffff, 0x8005)`, "crcCheck.getCrcValue() != 0"). The length counts the data and the CRC.
 */

import fs from 'node:fs';
import path from 'node:path';

import {crc16} from './frame.js';
import {mulberry32} from './prng.js';

/** The data bytes of a frame per rfd chunk: the first chunk carries 50 bytes (the two length bytes among them), the others 48 (BidcosInterfaceConcentrator::SendUpdataFrame). */
export const CHUNK_FIRST = 50;
export const CHUNK_NEXT = 48;

/**
 * The frames of a synthetic update file.
 * @param {{typeCode: number, firmware: number, frames?: number, size?: number, seed?: number}} options `size` is the
 *   number of filler bytes per frame (default 200), `frames` how many (default 3), `seed` the PRNG seed of the filler
 * @returns {Buffer[]} each frame's data with its CRC, without the length bytes
 */
export function buildUpdateFrames({typeCode, firmware, frames = 3, size = 200, seed = 1}) {
    const random = mulberry32(seed);
    const out = [];
    for (let i = 0; i < frames; i++) {
        const head = i === 0 ? [(typeCode >> 8) & 0xff, typeCode & 0xff, firmware & 0xff, frames & 0xff] : [];
        out.push(withCrc(Buffer.concat([Buffer.from(head), random.bytes(size)])));
    }
    return out;
}

/** Appends the CRC-16 that makes the frame check to zero. */
export function withCrc(data) {
    const crc = crc16(data);
    return Buffer.concat([data, Buffer.from([(crc >> 8) & 0xff, crc & 0xff])]);
}

/** Whether a frame (data with its CRC) checks to zero. */
export function crcOk(frame) {
    return frame.length >= 2 && crc16(frame) === 0;
}

/**
 * The `.eq3` text of the frames: `LLLL` + hex, concatenated.
 * @param {Buffer[]} frames
 * @param {{upper?: boolean}} [options]
 */
export function encodeEq3(frames, {upper = false} = {}) {
    return frames
        .map((f) => {
            const hex = `${f.length.toString(16).padStart(4, '0')}${Buffer.from(f).toString('hex')}`;
            return upper ? hex.toUpperCase() : hex;
        })
        .join('');
}

/**
 * The frames of an `.eq3` text, as `UpdateFile::Read` would take them (length bytes included, as rfd sends them).
 * @param {string} text
 * @returns {Buffer[]|null} null when the file is not whole (a frame cut short)
 */
export function decodeEq3(text) {
    const frames = [];
    let pos = 0;
    while (pos < text.length) {
        if (pos + 4 > text.length) {
            return null;
        }
        const length = parseInt(text.slice(pos, pos + 4), 16);
        const end = pos + 4 + length * 2;
        if (end > text.length) {
            return null;
        }
        frames.push(
            Buffer.concat([
                Buffer.from([(length >> 8) & 0xff, length & 0xff]),
                Buffer.from(text.slice(pos + 4, end), 'hex'),
            ]),
        );
        pos = end;
    }
    return frames;
}

/**
 * The chunks rfd makes of one update frame (SendUpdataFrame): the frame with its two length bytes in front, the
 * first chunk of 50 bytes, then 48-byte chunks while more than 52 bytes remain, the rest as the last chunk.
 * @param {Buffer} frame the frame's data with CRC (without the length bytes)
 * @returns {Buffer[]}
 */
export function chunksOf(frame) {
    const whole = Buffer.concat([Buffer.from([(frame.length >> 8) & 0xff, frame.length & 0xff]), frame]);
    const chunks = [];
    let index = 0;
    let first = true;
    while (index < whole.length - (2 + CHUNK_NEXT + 2)) {
        const size = first ? CHUNK_FIRST : CHUNK_NEXT;
        chunks.push(whole.subarray(index, index + size));
        index += size;
        first = false;
    }
    chunks.push(whole.subarray(index));
    return chunks;
}

/**
 * Writes an `.eq3` file and the `fwmap` line for it into rfd's `Firmware Dir`.
 * @param {string} dir rfd's `Firmware Dir`
 * @param {{typeCode: number, version: string, file?: string, frames: Buffer[], extraLines?: string[]}} options
 *   `version` as the fwmap says it ("2.12"); `extraLines` go in front of the entry (comments, other entries)
 * @returns {string} the file's path
 */
export function writeFwmapEntry(dir, {typeCode, version, file = `hmrs_${typeCode}.eq3`, frames, extraLines = []}) {
    fs.mkdirSync(dir, {recursive: true});
    const target = path.join(dir, file);
    fs.writeFileSync(target, encodeEq3(frames));
    const map = path.join(dir, 'fwmap');
    const existing = fs.existsSync(map) ? fs.readFileSync(map, 'utf8') : '';
    fs.writeFileSync(map, `${existing}${[...extraLines, `${typeCode} ${file} ${version}`].join('\n')}\n`);
    return target;
}

/**
 * A user-deployed firmware (`User Firmware Dir/<name>/info` + the `.eq3`), as `RFFirmwareManager::ReadUserFirmwarePath`
 * reads it: `TypeCode=<decimal>` and `FirmwareVersion=<x.y>` in `info`, the first `.eq3` in the directory.
 * @param {string} dir rfd's `User Firmware Dir`
 * @param {{name: string, typeCode: number, version: string, frames?: Buffer[], info?: string}} options `info`
 *   replaces the generated file's text
 */
export function writeUserFirmware(dir, {name, typeCode, version, frames = [], info = null}) {
    const sub = path.join(dir, name);
    fs.mkdirSync(sub, {recursive: true});
    fs.writeFileSync(path.join(sub, `${name}.eq3`), encodeEq3(frames));
    fs.writeFileSync(path.join(sub, 'info'), info ?? `# ${name}\nTypeCode=${typeCode}\nFirmwareVersion=${version}\n`);
    return sub;
}

/**
 * Intel HEX text for a byte buffer: data records (type 00) of `recordLength` bytes from `start`, then the end record.
 * @param {Uint8Array} bytes
 * @param {{start?: number, recordLength?: number, breakChecksumAt?: number|null, extraRecords?: string[]}} [options]
 *   `breakChecksumAt` spoils the checksum of that record (index); `extraRecords` are inserted before the end record
 *   (whole lines, e.g. an extended-address record)
 */
export function encodeIntelHex(bytes, {start = 0, recordLength = 16, breakChecksumAt = null, extraRecords = []} = {}) {
    const lines = [];
    for (let offset = 0, i = 0; offset < bytes.length; offset += recordLength, i++) {
        const chunk = Buffer.from(bytes.subarray(offset, offset + recordLength));
        const address = start + offset;
        const body = [chunk.length, (address >> 8) & 0xff, address & 0xff, 0x00, ...chunk];
        let sum = body.reduce((a, b) => a + b, 0);
        let checksum = -sum & 0xff;
        if (breakChecksumAt === i) {
            checksum ^= 0x55;
        }
        lines.push(
            `:${Buffer.from([...body, checksum])
                .toString('hex')
                .toUpperCase()}`,
        );
    }
    lines.push(...extraRecords);
    lines.push(':00000001FF');
    return `${lines.join('\n')}\n`;
}

/**
 * A synthetic wired firmware image: `size` pseudo-random bytes with the version word at `versionAddress`
 * (little-endian: minor, major - the way hs485d's `fwmap` entry `@addr` reads it).
 * @param {{size?: number, seed?: number, version?: [number, number], versionAddress?: number}} [options]
 */
export function buildWiredImage({size = 1024, seed = 7, version = [3, 6], versionAddress = 0x3fe} = {}) {
    const image = mulberry32(seed).bytes(size);
    if (versionAddress !== null && versionAddress + 1 < size) {
        image[versionAddress] = version[1] & 0xff;
        image[versionAddress + 1] = version[0] & 0xff;
    }
    return image;
}

/**
 * Writes a `.hex` file and the `fwmap` line for it into hs485d's `Firmware Dir`.
 * @param {string} dir
 * @param {{key: string, version: string, file?: string, text: string}} options `key` as hs485d builds it from the
 *   sysinfo (`H17V0`), `version` a literal ("3.06") or `@<address>` of the version word in the image
 */
export function writeWiredFwmapEntry(dir, {key, version, file = `hmrs_${key}.hex`, text}) {
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, file), text);
    const map = path.join(dir, 'fwmap');
    const existing = fs.existsSync(map) ? fs.readFileSync(map, 'utf8') : '';
    fs.writeFileSync(map, `${existing}${key} ${file} ${version}\n`);
    return path.join(dir, file);
}
