import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough, Duplex} from 'node:stream';

import {RadioModule} from '../../lib/module.js';
import {encodeTelegram, decodeTelegram} from '../../lib/telegram.js';
import {encodeFrame, FrameParser} from '../../lib/frame.js';
import {
    TYPE,
    SYSTEM,
    SYSTEM_STATUS,
    BIDCOS,
    BIDCOS_STATUS,
    IDENTIFY_APP,
    IDENTIFY_BOOTLOADER,
} from '../../lib/commands.js';

/** A duplex pair: what the test writes arrives at the module, what the module writes arrives at the test. */
function harness(options = {}) {
    const toModule = new PassThrough();
    const fromModule = new PassThrough();
    const moduleSide = Duplex.from({readable: toModule, writable: fromModule});
    const module = new RadioModule({responseDelayMs: 0, modeSwitchDelayMs: 5, sendDelayMs: 5, ...options});
    module.attach(moduleSide);
    const parser = new FrameParser();
    const frames = [];
    const raw = [];
    fromModule.on('data', (chunk) => {
        raw.push(Buffer.from(chunk));
        for (const r of parser.push(chunk)) {
            if (r.payload) {
                frames.push(Buffer.from(r.payload));
            }
        }
    });
    let counter = 0;
    const send = (type, command, data = []) => {
        const cnt = counter++ & 0xff;
        toModule.write(encodeFrame(Buffer.from([type, cnt, command, ...data])));
        return cnt;
    };
    const waitFrames = async (n, timeout = 1000) => {
        const until = Date.now() + timeout;
        while (frames.length < n && Date.now() < until) {
            await new Promise((r) => setTimeout(r, 2));
        }
        assert.ok(frames.length >= n, `expected ${n} frames, got ${frames.length}`);
        return frames;
    };
    return {module, send, frames, raw, waitFrames};
}

test('IDENTIFY answers Co_CPU_App with the request counter', async () => {
    const h = harness();
    const cnt = h.send(TYPE.SYSTEM, SYSTEM.IDENTIFY);
    const [frame] = await h.waitFrames(1);
    assert.deepEqual([...frame.subarray(0, 4)], [TYPE.SYSTEM, cnt, SYSTEM.RESPONSE_STATUS, SYSTEM_STATUS.DATA]);
    assert.equal(frame.subarray(4).toString('ascii'), IDENTIFY_APP);
    assert.equal(h.module.commands[0].name, 'IDENTIFY');
});

test('GETVERSION and GET_SERIALNR carry the configured values', async () => {
    const h = harness({serial: 'ABC1234567', firmwareVersion: [1, 2, 3], bootloaderVersion: [4, 5, 6]});
    h.send(TYPE.SYSTEM, SYSTEM.GETVERSION);
    h.send(TYPE.SYSTEM, SYSTEM.GET_SERIALNR);
    const [version, serial] = await h.waitFrames(2);
    assert.deepEqual([...version.subarray(4)], [4, 5, 6, 1, 2, 3]);
    assert.equal(serial.subarray(4).toString('ascii'), 'ABC1234567');
});

test('bootloader: STARTBOOTLOADER is acknowledged, then the restarted module announces Co_CPU_App with counter 0', async () => {
    const h = harness({mode: 'bootloader'});
    h.send(TYPE.SYSTEM, SYSTEM.IDENTIFY);
    const [identify] = await h.waitFrames(1);
    assert.equal(identify.subarray(4).toString('ascii'), IDENTIFY_BOOTLOADER);
    const cnt = h.send(TYPE.SYSTEM, SYSTEM.STARTBOOTLOADER);
    const [, ok, event] = await h.waitFrames(3);
    assert.deepEqual([...ok.subarray(0, 4)], [TYPE.SYSTEM, cnt, SYSTEM.RESPONSE_STATUS, SYSTEM_STATUS.OK]);
    assert.deepEqual([...event.subarray(0, 3)], [TYPE.SYSTEM, 0, SYSTEM.IDENTIFY], 'the announcement, counter 0');
    assert.equal(event.subarray(3).toString('ascii'), IDENTIFY_APP);
    assert.equal(h.module.mode, 'app');
});

test('a STARTBOOTLOADER during the restart is lost: no toggling back, no answer', async () => {
    const h = harness();
    h.send(TYPE.SYSTEM, SYSTEM.STARTBOOTLOADER);
    h.send(TYPE.SYSTEM, SYSTEM.STARTBOOTLOADER);
    await h.waitFrames(2);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.frames.length, 2, 'one OK and one announcement');
    assert.equal(h.module.mode, 'bootloader');
});

test('the announcement after entering the bootloader is the frame hmlangw expects from a real module', async () => {
    // hmlangw (MIT) waits for exactly these bytes after its enter-bootloader command: FD 00 0C 00 00 00 "Co_CPU_BL" 72 51
    const h = harness();
    h.send(TYPE.SYSTEM, SYSTEM.STARTBOOTLOADER);
    await h.waitFrames(2);
    const raw = h.raw[h.raw.length - 1];
    assert.equal(raw.toString('hex'), 'fd000c000000436f5f4350555f424c7251');
});

test('without startBootloaderAcknowledged the command gets no answer, only the announcement', async () => {
    const h = harness({startBootloaderAcknowledged: false});
    h.send(TYPE.SYSTEM, SYSTEM.STARTBOOTLOADER);
    const [event] = await h.waitFrames(1);
    assert.deepEqual([...event.subarray(0, 3)], [TYPE.SYSTEM, 0, SYSTEM.IDENTIFY]);
    assert.equal(event.subarray(3).toString('ascii'), IDENTIFY_BOOTLOADER);
    assert.equal(h.module.mode, 'bootloader');
});

test('SET_CLOCK stores the time, SET_RF_ADDRESS the address, GET_RF_ADDRESS returns it as DATA', async () => {
    const h = harness();
    const clock = Buffer.alloc(5);
    clock.writeUInt32BE(1760000000, 0);
    clock.writeInt8(4, 4);
    h.send(TYPE.SYSTEM, SYSTEM.SET_CLOCK, [...clock]);
    h.send(TYPE.BIDCOS, BIDCOS.SET_RF_ADDRESS, [0x3a, 0x2b, 0x1c]);
    const cnt = h.send(TYPE.BIDCOS, BIDCOS.GET_RF_ADDRESS);
    const [, setAddress, getAddress] = await h.waitFrames(3);
    assert.deepEqual(h.module.clock, {utcSeconds: 1760000000, offsetHalfHours: 4});
    assert.equal(h.module.rfAddress, 0x3a2b1c);
    assert.deepEqual([...setAddress.subarray(0, 4)], [TYPE.BIDCOS, 1, BIDCOS.STATUS, BIDCOS_STATUS.OK]);
    assert.deepEqual(
        [...getAddress],
        [TYPE.BIDCOS, cnt, BIDCOS.STATUS, BIDCOS_STATUS.DATA, 0x00, 0x01, 0x3a, 0x2b, 0x1c],
    );
});

test('peers and keys are remembered', async () => {
    const h = harness();
    h.send(TYPE.BIDCOS, BIDCOS.ADD_LINK_PEER, [0x12, 0x34, 0x56, 0x00]);
    h.send(TYPE.BIDCOS, BIDCOS.ADD_LINK_PEER, [0xab, 0xcd, 0xef, 0x00]);
    h.send(TYPE.BIDCOS, BIDCOS.SET_CURRENT_AES_KEY, [0x01, ...Buffer.alloc(16, 0x11)]);
    h.send(TYPE.BIDCOS, BIDCOS.GET_LINK_PEERS);
    const frames = await h.waitFrames(4);
    assert.deepEqual([...h.module.peers.keys()], [0x123456, 0xabcdef]);
    assert.ok(h.module.aesKeys.has('SET_CURRENT_AES_KEY'));
    assert.deepEqual([...frames[3].subarray(6)], [0x12, 0x34, 0x56, 0xab, 0xcd, 0xef]);
});

test('a BidCoS command in bootloader mode answers NOT_INITIALIZED', async () => {
    const h = harness({mode: 'bootloader'});
    h.send(TYPE.BIDCOS, BIDCOS.SET_RF_ADDRESS, [1, 2, 3]);
    const [frame] = await h.waitFrames(1);
    assert.equal(frame[3], BIDCOS_STATUS.NOT_INITIALIZED);
});

test('inject: BUSY once, then the normal answer; drop: no answer', async () => {
    const h = harness();
    h.module.inject('GET_SERIALNR', {status: SYSTEM_STATUS.BUSY});
    h.module.inject('GETVERSION', {drop: true});
    h.send(TYPE.SYSTEM, SYSTEM.GET_SERIALNR);
    h.send(TYPE.SYSTEM, SYSTEM.GETVERSION);
    h.send(TYPE.SYSTEM, SYSTEM.GET_SERIALNR);
    const frames = await h.waitFrames(2);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(frames.length, 2);
    assert.equal(frames[0][3], SYSTEM_STATUS.BUSY);
    assert.equal(frames[1][3], SYSTEM_STATUS.DATA);
    assert.equal(h.module.commands.length, 3);
});

test('SEND_TELEGRAM: the default air reports TELEGRAM_SENT; an acknowledging air reports the ACK within rfd limits', async () => {
    const h = harness();
    const telegram = encodeTelegram({
        counter: 7,
        flags: 0xa0,
        type: 0x11,
        src: 0x3a2b1c,
        dst: 0x123456,
        payload: [0x02, 0x01, 0xc8],
    });
    const cnt = h.send(TYPE.BIDCOS, BIDCOS.SEND_TELEGRAM, [0x00, 0x00, 0x00, ...telegram]);
    const [sent] = await h.waitFrames(1);
    assert.deepEqual([...sent], [TYPE.BIDCOS, cnt, BIDCOS.STATUS, BIDCOS_STATUS.TELEGRAM_SENT]);
    const seen = h.module.commands.at(-1);
    assert.equal(seen.name, 'SEND_TELEGRAM');
    assert.deepEqual(decodeTelegram(seen.data.subarray(3)).dst, 0x123456);

    h.module.air = async (request) => RadioModule.acknowledged(request, {payload: [0x01, 0x01, 0xc8, 0x00, 0x2c]});
    h.send(TYPE.BIDCOS, BIDCOS.SEND_TELEGRAM, [0x00, 0x00, 0x00, ...telegram]);
    const [, acked] = await h.waitFrames(2);
    assert.equal(acked[3], BIDCOS_STATUS.TELEGRAM_SENT_RECVD_ACK);
    // rfd accepts an acknowledged-telegram response of 15 to 32 payload bytes
    assert.ok(acked.length >= 15 && acked.length <= 32, `size ${acked.length}`);
    const ack = decodeTelegram(acked.subarray(6));
    assert.equal(ack.type, 0x02);
    assert.equal(ack.src, 0x123456);
    assert.equal(ack.dst, 0x3a2b1c);
    assert.equal(ack.counter, 7);
});

test('events: an event frame stays within the size rfd accepts; the duty-cycle event carries half-percent units', async () => {
    const h = harness();
    h.module.sendEvent(
        {counter: 1, flags: 0x84, type: 0x40, src: 0xabcdef, dst: 0x3a2b1c, payload: [0x01, 0x02]},
        {rssi: -70},
    );
    h.module.sendDutyCycleEvent(37);
    const [event, duty] = await h.waitFrames(2);
    assert.equal(event[0], TYPE.BIDCOS);
    assert.equal(event[2], BIDCOS.EVENT);
    assert.equal(event[5], 70);
    assert.ok(event.length >= 15 && event.length <= 32, `size ${event.length}`);
    assert.deepEqual([...duty.subarray(2)], [SYSTEM.EVENT_DUTYCYCLE, 74]);
});

test('waitForCommand resolves on the n-th command of a name and rejects on timeout', async () => {
    const h = harness();
    const waiting = h.module.waitForCommand('IDENTIFY', {count: 2, timeout: 500});
    h.send(TYPE.SYSTEM, SYSTEM.IDENTIFY);
    h.send(TYPE.SYSTEM, SYSTEM.IDENTIFY);
    const record = await waiting;
    assert.equal(record.counter, 1);
    await assert.rejects(h.module.waitForCommand('GETVERSION', {timeout: 30}), /timeout waiting for GETVERSION/);
});

test('attach replaces the stream; writes without a stream are refused', () => {
    const module = new RadioModule();
    assert.equal(module.writeRaw(Buffer.from([1])), false);
    const a = new PassThrough();
    const b = new PassThrough();
    module.attach(a);
    module.attach(b);
    assert.equal(module.attached, true);
    module.detach();
    assert.equal(module.attached, false);
    assert.equal(a.listenerCount('data'), 0);
});
