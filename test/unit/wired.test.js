import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {loadDeviceDescription} from '../../lib/rftypes.js';
import {WiredBus, WiredDevice, WIRED_BROADCAST, WIRED_CENTRAL, WCTRL, wiredTelegram} from '../../lib/wired.js';
import {HmwLgwFront, encodeTransportFrame, TransportParser} from '../../lib/hmwlgw.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const description = loadDeviceDescription(path.join(here, '..', 'fixtures', 'hs485types', 'sim_wired_switch.xml'));
const CENTRAL = WIRED_CENTRAL;

function device(options = {}) {
    return new WiredDevice({
        address: 0x00001234,
        serial: 'SIMW000001',
        description,
        typeId: 'HMW-LC-Sw2-DR',
        sysinfo: [0x11, 0x00, 0x03, 0x03],
        ...options,
    });
}

test('transport frames: escapes, the length byte, a stream cut at any point', () => {
    const payload = Buffer.from([0x01, 0x53, 0xfd, 0xfc, 0x7f, 0x80]);
    const frame = encodeTransportFrame(payload);
    assert.deepEqual([...frame], [0xfd, 6, 0x01, 0x53, 0xfc, 0x7d, 0xfc, 0x7c, 0x7f, 0x80]);
    const seen = [];
    const parser = new TransportParser((f) => seen.push(f));
    for (const b of frame) {
        parser.feed(Buffer.from([b]));
    }
    parser.feed(Buffer.concat([Buffer.from('xx'), encodeTransportFrame(Buffer.from([2, 0x4b]))]));
    assert.equal(seen.length, 2);
    assert.deepEqual([...seen[0]], [...payload]);
    assert.deepEqual([...seen[1]], [2, 0x4b]);
});

test('the wired device: sysinfo for h/v, the serial, EEPROM read/write/usage, the control byte counters', () => {
    const dev = device();
    const ctrl = WCTRL.IFRAME | WCTRL.SYN;
    const h = dev.handle(CENTRAL, ctrl, Buffer.from('h'), false);
    assert.deepEqual([...h.data], [0x11, 0x00]);
    assert.equal(h.ctrl & 0x80, 0x80, 'the first frame to the central carries SYN');
    const v = dev.handle(CENTRAL, ctrl, Buffer.from('v'), false);
    assert.deepEqual([...v.data], [0x03, 0x03]);
    assert.equal(v.ctrl & 0x80, 0, 'then no SYN');
    assert.notEqual((h.ctrl >> 1) & 3, (v.ctrl >> 1) & 3, 'the tx counter moves');
    assert.equal(dev.handle(CENTRAL, ctrl, Buffer.from('n'), false).data.toString(), 'SIMW000001');
    // EEPROM: all 0xff at start, usage bits clear; a write makes the chunk used
    const usage = dev.handle(CENTRAL, ctrl, Buffer.from([0x45, 0x00, 0x00, 0x10, 0x40]), false);
    assert.equal(usage.data[0], 0x65);
    assert.deepEqual([...usage.data.subarray(1, 4)], [0x00, 0x00, 0x10]);
    assert.ok(usage.data.subarray(4).every((b) => b === 0));
    const w = dev.handle(CENTRAL, ctrl, Buffer.from([0x57, 0x00, 0x01, 0x02, 50, 7]), false);
    assert.equal(w.ctrl, WCTRL.ACK);
    assert.equal(w.data.length, 0);
    assert.deepEqual([...dev.eeprom.subarray(0, 4)], [0xff, 50, 7, 0xff]);
    const r = dev.handle(CENTRAL, ctrl, Buffer.from([0x52, 0x00, 0x00, 0x04]), false);
    assert.deepEqual([...r.data], [0xff, 50, 7, 0xff]);
    const usage2 = dev.handle(CENTRAL, ctrl, Buffer.from([0x45, 0x00, 0x00, 0x10, 0x40]), false);
    assert.equal(usage2.data[4] & 1, 1, 'chunk 0 is used now');
    assert.equal(dev.handle(CENTRAL, ctrl, Buffer.from('z'), true), null, 'sleep-mode broadcasts get no answer');
    dev.answering = false;
    assert.equal(dev.handle(CENTRAL, ctrl, Buffer.from('h'), false), null);
});

test('the wired switch: LEVEL_SET is acknowledged and followed by INFO_LEVEL, LEVEL_GET answers it, a key press', async () => {
    const dev = device({infoDelayMs: 5});
    const bus = new WiredBus({ackDelayMs: 1});
    bus.add(dev);
    const events = [];
    bus.on('event', (e) => events.push(e));
    // x ch=3 state=200: the frame as hs485d builds it from the description (channel at index 10, STATE at 11)
    const set = await bus.deliver({
        receiver: dev.address,
        ctrl: WCTRL.IFRAME | WCTRL.SYN,
        sender: CENTRAL,
        payload: Buffer.from([0x78, 0x02, 0xc8]),
    });
    assert.equal(set.ctrl, WCTRL.ACK);
    assert.equal(dev.behaviour.channel(2).STATE, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.length, 1, 'the INFO_LEVEL after the set');
    assert.equal(events[0].sender, dev.address);
    assert.equal(events[0].receiver, CENTRAL);
    assert.deepEqual([...events[0].payload], [0x69, 0x02, 0xc8, 0x00]);
    const get = await bus.deliver({
        receiver: dev.address,
        ctrl: WCTRL.IFRAME,
        sender: CENTRAL,
        payload: Buffer.from([0x53, 0x02]),
    });
    assert.deepEqual([...get.data], [0x69, 0x02, 0xc8, 0x00]);
    assert.equal(get.ctrl & 0x01, 0, 'an I-frame');
    dev.press(0, {long: false});
    dev.press(0, {long: true});
    assert.equal(events.length, 3);
    assert.equal(events[1].payload[0], 0x4b);
    assert.equal(events[1].payload[1], 0x00, 'key channel');
    // index 12 of the frame = payload offset 3: bit 0 long, bits 2..7 the counter
    assert.equal(events[1].payload[3] & 0x01, 0, 'short');
    assert.equal(events[2].payload[3] & 0x01, 1, 'long');
    assert.equal(events[2].payload[3] >> 2, 2, 'the key counter');
    assert.equal(
        await bus.deliver({receiver: 0x99, ctrl: 0, sender: CENTRAL, payload: Buffer.from('h')}),
        null,
        'no such device',
    );
    assert.deepEqual(bus.traceLines().slice(0, 2), ['tx LEVEL_SET ch2', 'rx INFO_LEVEL ch2']);
    dev.announce();
    const a = events[3];
    assert.equal(a.receiver, WIRED_BROADCAST);
    assert.equal(a.payload.length, 1 + 1 + 4 + 10);
    assert.equal(wiredTelegram(a.receiver, a.ctrl, a.sender, a.payload).length, 25);
});

/** A client that speaks the plaintext preamble and then transport frames, like hs485d. */
async function connectClient(front) {
    const socket = net.connect(front.port, front.host);
    await new Promise((resolve) => socket.once('connect', resolve));
    const frames = [];
    const parser = new TransportParser((f) => frames.push(f));
    let text = '';
    let relay = false;
    socket.on('data', (chunk) => {
        if (relay) {
            parser.feed(chunk);
            return;
        }
        text += chunk.toString('latin1');
        let i;
        while ((i = text.indexOf('\n')) !== -1) {
            const line = text.slice(0, i).replace(/\r$/, '');
            text = text.slice(i + 1);
            if (line[0] === 'S') {
                socket.write(`>${line.slice(1, 3)},0000\r\n`);
                relay = true;
                if (text.length) {
                    parser.feed(Buffer.from(text, 'latin1'));
                    text = '';
                }
            }
        }
    });
    const until = Date.now() + 2000;
    while (!relay && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(relay, 'the switch to the binary protocol');
    const waitFrames = async (n) => {
        const end = Date.now() + 2000;
        while (frames.length < n && Date.now() < end) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(frames.length >= n, `expected ${n} frames, got ${frames.length}`);
        return frames;
    };
    return {socket, frames, waitFrames, send: (payload) => socket.write(encodeTransportFrame(Buffer.from(payload)))};
}

test('the HMW-LGW front: keepalive, discovery, a send answered by the device, a silent address, an event', async () => {
    const bus = new WiredBus({ackDelayMs: 1});
    const dev = bus.add(device({infoDelayMs: 5}));
    const front = new HmwLgwFront({bus, port: 0, discoveryGapMs: 1, silentDeviceMs: 20});
    await front.start();
    try {
        const client = await connectClient(front);
        client.send([0x01, 0x4b]);
        let frames = await client.waitFrames(1);
        assert.deepEqual([...frames[0]], [0x01, 0x61, 0x00], 'a 00 for the keepalive, same counter');
        assert.equal(front.keepalives, 1);
        client.send([0x02, 0x44, 0x00, 0xff]);
        frames = await client.waitFrames(3);
        assert.deepEqual([...frames[1]], [0x02, 0x64, 0x00, 0x00, 0x12, 0x34]);
        assert.deepEqual([...frames[2]], [0x02, 0x63, 0x00, 0x00, 0x01]);
        // S timeout receiver ctrl sender 'h'
        client.send([0x03, 0x53, 0xc8, 0x00, 0x00, 0x12, 0x34, WCTRL.IFRAME | WCTRL.SYN, 0x00, 0x00, 0x00, 0x01, 0x68]);
        frames = await client.waitFrames(4);
        assert.equal(frames[3][0], 0x03);
        assert.equal(frames[3][1], 0x72, 'r');
        assert.deepEqual([...frames[3].subarray(3)], [0x11, 0x00]);
        // an address nobody has: a 01 after the gateway's wait (silentDeviceMs)
        client.send([0x04, 0x53, 0x32, 0x00, 0x00, 0x00, 0x99, WCTRL.IFRAME, 0x00, 0x00, 0x00, 0x01, 0x68]);
        frames = await client.waitFrames(5);
        assert.deepEqual([...frames[4]], [0x04, 0x61, 0x01]);
        // the device's own frame: an event with the gateway's counter
        dev.press(1);
        frames = await client.waitFrames(6);
        assert.equal(frames[5][1], 0x65);
        assert.equal(frames[5].readUInt32BE(2), CENTRAL);
        assert.equal(frames[5].readUInt32BE(7), dev.address);
        assert.equal(frames[5][11], 0x4b);
        assert.deepEqual(front.commandLines(), [
            'rx K',
            'tx a',
            'rx D',
            'tx d',
            'tx c',
            'rx S',
            'tx r',
            'rx S',
            'tx a',
            'tx e',
        ]);
        client.socket.destroy();
    } finally {
        await front.close();
    }
});

test('the HMW-LGW front: a device that does not answer gets a 01 after the measured ~620 ms, each try', async () => {
    // measured 2026-10-11 on a real HMW-LGW 1.0.5 with the device off the bus: hs485d logged LGW_RPL_ANSWER ERROR 636 ms
    // after the RPC and 619 ms later for its second try; hs485d's own HS485_RESPONSE_TIMEOUT is 700 ms
    const bus = new WiredBus({ackDelayMs: 1});
    const dev = bus.add(device());
    dev.answering = false;
    const front = new HmwLgwFront({bus, port: 0});
    assert.equal(front.silentDeviceMs, 620, 'the default is the measured wait');
    await front.start();
    try {
        const client = await connectClient(front);
        const frame = (counter) => [
            counter,
            0x53,
            0x0a,
            0x00,
            0x00,
            0x12,
            0x34,
            WCTRL.IFRAME,
            0x00,
            0x00,
            0x00,
            0x01,
            0x68,
        ];
        for (const [i, counter] of [0x05, 0x06].entries()) {
            const started = Date.now();
            client.send(frame(counter));
            const frames = await client.waitFrames(i + 1);
            const took = Date.now() - started;
            assert.deepEqual([...frames[i]], [counter, 0x61, 0x01], "a 01 with the request's counter");
            assert.ok(took >= 560 && took < 700, `a 01 after ${took} ms (expected ~620, below hs485d's 700)`);
        }
        client.socket.destroy();
    } finally {
        await front.close();
    }
});
