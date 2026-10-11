import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough, Duplex} from 'node:stream';

import {
    loadDeviceDescription,
    parseXml,
    matchFrame,
    buildFramePayload,
    frameById,
    sysinfoForType,
    readField,
    writeField,
} from '../../lib/rftypes.js';
import {BidcosDevice} from '../../lib/device.js';
import {Air, describeTelegram} from '../../lib/air.js';
import {RadioModule} from '../../lib/module.js';
import {encodeTelegram, decodeTelegram, CTRL, FT, CONFIG, ACK, INFO} from '../../lib/telegram.js';
import {TYPE, BIDCOS, BIDCOS_STATUS} from '../../lib/commands.js';
import {encodeFrame, FrameParser} from '../../lib/frame.js';

const FIXTURE = new URL('../fixtures/rftypes/sim_switch.xml', import.meta.url).pathname;
const CENTRAL = 0x3a2b1c;
const DEVICE = 0x123456;

test('parseXml: elements, attributes, entities, comments and self-closing tags', () => {
    const root = parseXml(`<?xml version="1.0"?><!-- c --><a x="1" y='two &amp; three'><b/><c>t&lt;x</c></a>`);
    assert.equal(root.name, 'a');
    assert.deepEqual(root.attrs, {x: '1', y: 'two & three'});
    assert.equal(root.children.length, 2);
    assert.equal(root.children[1].text, 't<x');
});

test('loadDeviceDescription reads types, channels, frames and the config parameters', () => {
    const d = loadDeviceDescription(FIXTURE);
    assert.equal(d.supportsAes, true);
    assert.equal(d.rxModes, 'ALWAYS');
    assert.deepEqual(sysinfoForType(d, 'SIM-Sw1'), {firmware: 0x24, type: 0x0011});
    assert.deepEqual(
        d.frames.map((f) => f.id),
        ['LEVEL_SET', 'SET_LOCK', 'LEVEL_GET', 'INFO_LEVEL', 'ACK_STATUS', 'TOGGLE_INSTALL_TEST'],
    );
    assert.deepEqual(d.channels[1].paramsets.MASTER.config.TRANSMIT_TRY_MAX, {list: 1, byte: 48, bit: 0, bits: 8});
    assert.deepEqual(d.channels[1].paramsets.MASTER.config.STATUSINFO_MINDELAY, {list: 1, byte: 87, bit: 0, bits: 5});
    assert.deepEqual(d.paramsets.MASTER.config.INTERNAL_KEYS_VISIBLE, {list: 0, byte: 2, bit: 7, bits: 1});
});

test('matchFrame and buildFramePayload round-trip the XML frames, bit fields included', () => {
    const d = loadDeviceDescription(FIXTURE);
    const set = encodeTelegram({
        counter: 5,
        ctrl: 0xa0,
        type: 0x11,
        src: CENTRAL,
        dst: DEVICE,
        payload: [0x02, 0x01, 0xc8, 0, 0],
    });
    const m = matchFrame(d, set, 'to_device');
    assert.equal(m.frame.id, 'LEVEL_SET');
    assert.equal(m.channel, 1);
    assert.deepEqual(m.values, {STATE: 200, ON_TIME: 0});
    const info = buildFramePayload(frameById(d, 'INFO_LEVEL'), {channel: 1, values: {STATE: 200, STATE_FLAGS: 0b101}});
    assert.equal(info.toString('hex'), '0601c850');
    const back = matchFrame(d, encodeTelegram({type: 0x10, src: DEVICE, dst: CENTRAL, payload: info}), 'from_device');
    assert.equal(back.frame.id, 'INFO_LEVEL');
    assert.deepEqual(back.values, {STATE: 200, STATE_FLAGS: 5});
    // a sub-byte field and a two-byte field
    let b = Buffer.alloc(14);
    b = writeField(b, 12, 4, 3, 5);
    b = writeField(b, 10, 0, 16, 0x1234);
    assert.equal(readField(b, 12, 4, 3), 5);
    assert.equal(readField(b, 10, 0, 16), 0x1234);
});

function device(options = {}) {
    const d = loadDeviceDescription(FIXTURE);
    return new BidcosDevice({address: DEVICE, serial: 'SIM0000123', description: d, typeId: 'SIM-Sw1', ...options});
}

function central(type, payload, counter = 1, ctrl = CTRL.BIDI | CTRL.RPT_ENABLE) {
    return encodeTelegram({counter, ctrl, type, src: CENTRAL, dst: DEVICE, payload});
}

test('the pairing announcement carries firmware, type, serial and the peering channel', () => {
    const dev = device();
    const t = decodeTelegram(dev.sysinfoTelegram());
    assert.equal(t.type, FT.SYSINFO);
    assert.equal(t.dst, 0);
    assert.equal(t.payload[0], 0x24);
    assert.equal(t.payload.readUInt16BE(1), 0x0011);
    assert.equal(t.payload.subarray(3, 13).toString('ascii'), 'SIM0000123');
    assert.equal(t.payload[14], 1, 'the channel count at index 23');
    assert.equal(t.payload[15], 1, 'peering channel A at index 24');
    assert.equal(t.payload.length, 17);
});

test('rfd pairs by writing list 0: CONFIG_START, WRITE_INDEX, END are acknowledged and stored', () => {
    const dev = device();
    const start = dev.receive(central(FT.CONFIG, [0x00, CONFIG.START, 0, 0, 0, 0, 0x00]));
    assert.equal(start.length, 1);
    assert.equal(decodeTelegram(start[0]).payload[0], ACK.ACK);
    assert.equal(decodeTelegram(start[0]).counter, 1, 'the response repeats the request counter');
    dev.receive(central(FT.CONFIG, [0x00, CONFIG.WRITE_INDEX, 0x02, 0x01, 0x0a, 0x3a, 0x0b, 0x2b, 0x0c, 0x1c], 2));
    dev.receive(central(FT.CONFIG, [0x00, CONFIG.END], 3));
    assert.equal(dev.pairedCentral(), CENTRAL);
    assert.equal(dev.list(0, 0).get(2), 1);
    assert.equal(dev.configSession, null);
});

test('CONFIG_PARAM_REQ answers INFO_PARAM_RESPONSE_PAIRS ending in 00 00; the peer list ends in four zero bytes', () => {
    const dev = device();
    dev.list(1, 1).set(48, 6);
    dev.list(1, 1).set(87, 0x24);
    const [pairs] = dev.receive(central(FT.CONFIG, [0x01, CONFIG.PARAM_REQ, 0, 0, 0, 0, 0x01]));
    const p = decodeTelegram(pairs).payload;
    assert.equal(p[0], INFO.PARAM_RESPONSE_PAIRS);
    assert.deepEqual([...p.subarray(1)], [48, 6, 87, 0x24, 0, 0]);
    // 12 pairs need two frames (8 pairs fit in one)
    for (let i = 0; i < 12; i++) {
        dev.list(1, 3, CENTRAL, 1).set(i, i);
    }
    const many = dev.receive(central(FT.CONFIG, [0x01, CONFIG.PARAM_REQ, 0x3a, 0x2b, 0x1c, 0x01, 0x03]));
    assert.equal(many.length, 2);
    assert.deepEqual([...decodeTelegram(many[1]).payload.slice(-2)], [0, 0]);
    const [peers] = dev.receive(central(FT.CONFIG, [0x01, CONFIG.PEER_LIST_REQ]));
    assert.deepEqual([...decodeTelegram(peers).payload], [INFO.PEER_LIST, 0, 0, 0, 0]);
    dev.receive(central(FT.CONFIG, [0x01, CONFIG.PEER_ADD, 0xab, 0xcd, 0xef, 0x01, 0x02]));
    const [peers2] = dev.receive(central(FT.CONFIG, [0x01, CONFIG.PEER_LIST_REQ]));
    assert.deepEqual(
        [...decodeTelegram(peers2).payload],
        [INFO.PEER_LIST, 0xab, 0xcd, 0xef, 1, 0xab, 0xcd, 0xef, 2, 0, 0, 0, 0],
    );
});

test('a LEVEL_SET switches the channel and is answered with ACK_STATUS; LEVEL_GET with INFO_LEVEL; AES container with ACK', () => {
    const dev = device();
    const [ack] = dev.receive(central(FT.CENTRAL, [0x02, 0x01, 0xc8, 0x00, 0x00]));
    const a = decodeTelegram(ack);
    assert.equal(a.type, FT.ACK_OR_NACK);
    assert.deepEqual([...a.payload.subarray(0, 4)], [ACK.ACK_STATUS, 0x01, 0xc8, 0x00]);
    assert.equal(a.payload.length, 5, 'plus the RSSI byte');
    assert.equal(dev.behaviour.channel(1).STATE, 200);
    const [info] = dev.receive(central(FT.CONFIG, [0x01, CONFIG.STATUS_REQ]));
    assert.deepEqual([...decodeTelegram(info).payload], [INFO.STATUS, 0x01, 0xc8, 0x00]);
    const [aes] = dev.receive(central(FT.AES_CONTAINER, [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    assert.equal(decodeTelegram(aes).payload[0], ACK.ACK);
    // not for us: nothing
    assert.deepEqual(dev.receive(encodeTelegram({type: 0x11, src: CENTRAL, dst: 0x999999, payload: [0x02, 1, 0]})), []);
});

/** The module on a duplex pair, as rfd would see it. */
function moduleHarness() {
    const toModule = new PassThrough();
    const fromModule = new PassThrough();
    const module = new RadioModule({responseDelayMs: 0, ackDelayMs: 5, sendDelayMs: 5, failDelayMs: 40});
    module.attach(Duplex.from({readable: toModule, writable: fromModule}));
    const parser = new FrameParser();
    const frames = [];
    fromModule.on('data', (chunk) => {
        for (const r of parser.push(chunk)) {
            if (r.payload) {
                frames.push(Buffer.from(r.payload));
            }
        }
    });
    const send = (telegram) =>
        toModule.write(encodeFrame(Buffer.from([TYPE.BIDCOS, 9, BIDCOS.SEND_TELEGRAM, 0, 0, 0, ...telegram])));
    const waitFrames = async (n, timeout = 1000) => {
        const until = Date.now() + timeout;
        while (frames.length < n && Date.now() < until) {
            await new Promise((r) => setTimeout(r, 2));
        }
        assert.ok(frames.length >= n, `expected ${n} frames, got ${frames.length}`);
        return frames;
    };
    return {module, send, frames, waitFrames};
}

test('the air: the first answer is the acknowledgement status, the rest come as events, no device means SEND_FAILED', async () => {
    const h = moduleHarness();
    const air = new Air({module: h.module, eventGapMs: 2});
    const dev = air.add(device());
    for (let i = 0; i < 10; i++) {
        dev.list(1, 1).set(i, i);
    }
    h.send(central(FT.CONFIG, [0x01, CONFIG.PARAM_REQ, 0, 0, 0, 0, 0x01], 7));
    const [status, event] = await h.waitFrames(2);
    assert.equal(status[3], BIDCOS_STATUS.TELEGRAM_SENT_RECVD_ACK);
    const first = decodeTelegram(status.subarray(6));
    assert.equal(first.payload[0], INFO.PARAM_RESPONSE_PAIRS);
    assert.equal(first.counter, 7);
    assert.equal(event[2], BIDCOS.EVENT);
    assert.deepEqual([...decodeTelegram(event.subarray(6)).payload.slice(-2)], [0, 0]);

    dev.answering = false;
    h.send(central(FT.CENTRAL, [0x02, 0x01, 0xc8, 0, 0], 8));
    const [, , failed] = await h.waitFrames(3);
    assert.equal(failed[3], BIDCOS_STATUS.SEND_FAILED);

    air.forceStatus(BIDCOS_STATUS.SEND_FAILED_DUTYCYCLE);
    dev.answering = true;
    h.send(central(FT.CENTRAL, [0x02, 0x01, 0xc8, 0, 0], 9));
    const [, , , dc] = await h.waitFrames(4);
    assert.equal(dc[3], BIDCOS_STATUS.SEND_FAILED_DUTYCYCLE);

    air.reportStatus(dev, 1);
    const [, , , , report] = await h.waitFrames(5);
    const r = decodeTelegram(report.subarray(6));
    assert.equal(r.type, FT.INFO);
    assert.equal(r.dst, CENTRAL, 'the device learned the central from the frames addressed to it');
    assert.deepEqual(air.traceLines(), [
        'tx CONFIG_PARAM_REQ [bidi]',
        'rx INFO_PARAM_RESPONSE_PAIRS',
        'rx INFO_PARAM_RESPONSE_PAIRS',
        'tx LEVEL_SET ch1 STATE=200 ON_TIME=0 [bidi]',
        'tx LEVEL_SET ch1 STATE=200 ON_TIME=0 [bidi]',
        'rx INFO_LEVEL ch1 STATE=0 STATE_FLAGS=0 [bidi]',
    ]);
    assert.equal(describeTelegram(dev.sysinfoTelegram()), 'SYSINFO [bcast]');
    h.module.close();
});

test('an AES-secured device: challenge, the module answers with the key rfd set, a signed ACK, AUTHENTICATION_SUCCESS', async () => {
    const h = moduleHarness();
    const air = new Air({module: h.module, eventGapMs: 2});
    const dev = air.add(device({aes: true, aesKeyIndex: 1}));
    // rfd's SET_CURRENT_AES_KEY: 16 key bytes, then the index
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    h.module.receive(encodeFrame(Buffer.from([TYPE.BIDCOS, 3, BIDCOS.SET_CURRENT_AES_KEY, ...key, 0x01])));
    await h.waitFrames(1);
    assert.ok(h.module.keyTable.get(1).equals(key));

    h.send(central(FT.CENTRAL, [0x02, 0x01, 0xc8, 0, 0], 5));
    const [, status] = await h.waitFrames(2);
    assert.equal(status[3], BIDCOS_STATUS.AUTHENTICATION_SUCCESS, `status ${status[3]}`);
    assert.equal(status[4], 1, 'the key index');
    const ack = decodeTelegram(status.subarray(6));
    assert.equal(ack.type, FT.ACK_OR_NACK);
    assert.equal(ack.payload.length, 5, 'ACK with the four signature bytes');
    assert.equal(dev.behaviour.channel(1).STATE, 200, 'the command took effect after the handshake');
    assert.deepEqual(
        air.traceLines().map((l) => l.replace(/ \[.*\]$/, '')),
        ['tx LEVEL_SET ch1 STATE=200 ON_TIME=0', 'rx ACK_W_AES_CHALLENGE', 'tx AES_SOLUTION', 'rx ACK (signed)'],
    );

    // a device on another key stays silent on the response: AUTHENTICATION_FAILURE
    const other = Buffer.from(key);
    other[0] ^= 0xff;
    dev.aesKey = other;
    h.send(central(FT.CENTRAL, [0x02, 0x01, 0x00, 0, 0], 6));
    const [, , failed] = await h.waitFrames(3);
    assert.equal(failed[3], BIDCOS_STATUS.AUTHENTICATION_FAILURE);
    assert.equal(dev.aesFailures, 1);
    assert.equal(dev.behaviour.channel(1).STATE, 200, 'the command did not take effect');
    h.module.close();
});

test('a sleeping device: deaf between windows, a burst wakes a burst device, the module wakes a wake-up device on request', async () => {
    const h = moduleHarness();
    const air = new Air({module: h.module, eventGapMs: 2});
    const dev = air.add(device({rxMode: 'wakeup', awakeMs: 50, listenAfterSendMs: 20}));
    assert.equal(dev.sleeps, true);
    assert.equal(dev.awake, false);
    h.send(central(FT.CENTRAL, [0x02, 0x01, 0xc8, 0, 0], 1));
    const [failed] = await h.waitFrames(1);
    assert.equal(failed[3], BIDCOS_STATUS.SEND_FAILED, 'a sleeping device does not hear the central');
    assert.equal(dev.behaviour.channel(1).STATE, 0);

    // rfd asks for the wake-up: ADD_LINK_PEER address, key index, wake-up 1, lazy 0
    h.module.receive(encodeFrame(Buffer.from([TYPE.BIDCOS, 4, BIDCOS.ADD_LINK_PEER, 0x12, 0x34, 0x56, 0, 1, 0])));
    await h.waitFrames(2);
    assert.deepEqual(h.module.wakeupRequest(DEVICE), {lazy: false});
    air.reportStatus(dev, 1);
    const [, , event] = await h.waitFrames(3);
    assert.equal(event[2], BIDCOS.EVENT);
    assert.equal(event[3] & 0x10, 0x10, 'the event carries WOKEN_UP');
    assert.ok(dev.awake, 'woken up');
    assert.deepEqual(air.traceLines().slice(-3), [
        'rx INFO_LEVEL ch1 STATE=0 STATE_FLAGS=0 [bidi]',
        'tx WAKEUP',
        'rx ACK',
    ]);
    h.send(central(FT.CENTRAL, [0x02, 0x01, 0xc8, 0, 0], 2));
    const [, , , ok] = await h.waitFrames(4);
    assert.equal(ok[3], BIDCOS_STATUS.TELEGRAM_SENT_RECVD_ACK, 'heard while awake');
    assert.equal(dev.behaviour.channel(1).STATE, 200);

    // rfd clears the request: the next event is a plain one
    h.module.receive(encodeFrame(Buffer.from([TYPE.BIDCOS, 5, BIDCOS.ADD_LINK_PEER, 0x12, 0x34, 0x56, 0, 0, 0])));
    await h.waitFrames(5);
    assert.equal(h.module.wakeupRequest(DEVICE), null);
    dev.sleep();
    air.reportStatus(dev, 1);
    const [, , , , , plain] = await h.waitFrames(6);
    assert.equal(plain[3] & 0x10, 0, 'no WOKEN_UP without a request');
    assert.equal(air.wakeups.length, 1);

    // a burst device: the burst flag wakes it, a plain telegram does not
    const ba = air.add(device({rxMode: 'burst', awakeMs: 50}));
    ba.address = DEVICE; // same address, replaces the wake-up device on the air
    air.devices.set(DEVICE, ba);
    h.send(central(FT.CENTRAL, [0x02, 0x01, 0xc8, 0, 0], 3));
    const frames7 = await h.waitFrames(7);
    assert.equal(frames7[6][3], BIDCOS_STATUS.SEND_FAILED);
    const started = Date.now();
    h.send(central(FT.CENTRAL, [0x02, 0x01, 0xc8, 0, 0], 4, CTRL.BIDI | CTRL.RPT_ENABLE | CTRL.BURST));
    const frames8 = await h.waitFrames(8, 2000);
    assert.equal(frames8[7][3], BIDCOS_STATUS.TELEGRAM_SENT_RECVD_ACK, 'the burst woke it');
    assert.ok(Date.now() - started >= 360, 'the burst preamble takes 360 ms');
    assert.ok(ba.awake, 'awake after the burst');
    h.module.close();
});
