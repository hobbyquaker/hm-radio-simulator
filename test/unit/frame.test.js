import {test} from 'node:test';
import assert from 'node:assert/strict';

import {crc16, encodeFrame, FrameParser, FRAME_START, ESCAPE} from '../../lib/frame.js';

test('crc16: the polynomial 0x8005 with init 0xFFFF', () => {
    // CRC-16/CMS parameters (poly 0x8005, init 0xFFFF, no reflection, no xorout): check value of "123456789"
    assert.equal(crc16(Buffer.from('123456789')), 0xaee7);
    assert.equal(crc16(Buffer.alloc(0)), 0xffff);
});

test('encodeFrame: start byte, big-endian length, payload, CRC', () => {
    const frame = encodeFrame(Buffer.from([0x00, 0x01, 0x00])); // IDENTIFY with counter 1
    assert.equal(frame[0], FRAME_START);
    assert.deepEqual([...frame.subarray(1, 3)], [0x00, 0x03]);
    assert.deepEqual([...frame.subarray(3, 6)], [0x00, 0x01, 0x00]);
    const crc = crc16(frame.subarray(1, 6));
    assert.deepEqual([...frame.subarray(6)], [(crc >> 8) & 0xff, crc & 0xff]);
});

test('encodeFrame: escapes 0xFD and 0xFC after the start byte', () => {
    const frame = encodeFrame(Buffer.from([0xfd, 0xfc, 0x7d]));
    const body = [...frame.subarray(3)];
    assert.deepEqual(body.slice(0, 4), [ESCAPE, 0x7d, ESCAPE, 0x7c]);
    assert.equal(body[4], 0x7d);
    const parsed = new FrameParser().push(frame);
    assert.equal(parsed.length, 1);
    assert.deepEqual([...parsed[0].payload], [0xfd, 0xfc, 0x7d]);
});

test('FrameParser: round trip of every payload length the module uses, in any chunking', () => {
    for (const length of [0, 1, 3, 14, 32, 66, 200]) {
        const payload = Buffer.alloc(length, 0xfd); // worst case: everything escaped
        const frame = encodeFrame(payload);
        for (const chunk of [1, 2, 3, 7, 256]) {
            const parser = new FrameParser();
            const results = [];
            for (let i = 0; i < frame.length; i += chunk) {
                results.push(...parser.push(frame.subarray(i, i + chunk)));
            }
            assert.equal(results.length, 1, `length ${length} chunk ${chunk}`);
            assert.deepEqual([...results[0].payload], [...payload]);
        }
    }
});

test('FrameParser: two frames in one chunk, a frame split across chunks', () => {
    const a = encodeFrame(Buffer.from([1, 2, 3]));
    const b = encodeFrame(Buffer.from([4, 5]));
    const joined = Buffer.concat([a, b]);
    const parser = new FrameParser();
    const results = parser.push(joined.subarray(0, 5));
    assert.equal(results.length, 0);
    const rest = parser.push(joined.subarray(5));
    assert.equal(rest.length, 2);
    assert.deepEqual([...rest[0].payload], [1, 2, 3]);
    assert.deepEqual([...rest[1].payload], [4, 5]);
});

test('FrameParser: a CRC error is reported, not delivered', () => {
    const frame = encodeFrame(Buffer.from([1, 2, 3]));
    frame[frame.length - 1] ^= 0xff;
    const results = new FrameParser().push(frame);
    assert.equal(results.length, 1);
    assert.equal(results[0].error, 'crc');
    assert.equal(results[0].payload, undefined);
});

test('FrameParser: a start byte inside a frame restarts it, noise before a start is ignored', () => {
    const parser = new FrameParser();
    const good = encodeFrame(Buffer.from([9]));
    const results = parser.push(Buffer.concat([Buffer.from([0x11, 0x22]), good.subarray(0, 3), good]));
    const payloads = results.filter((r) => r.payload);
    assert.equal(payloads.length, 1);
    assert.deepEqual([...payloads[0].payload], [9]);
    assert.equal(parser.stats.noise, 2);
    assert.equal(parser.stats.restarts, 1);
});
