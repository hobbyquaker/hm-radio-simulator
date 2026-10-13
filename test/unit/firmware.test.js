import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    buildUpdateFrames,
    withCrc,
    crcOk,
    encodeEq3,
    decodeEq3,
    chunksOf,
    writeFwmapEntry,
    writeUserFirmware,
    encodeIntelHex,
    buildWiredImage,
    writeWiredFwmapEntry,
    CHUNK_FIRST,
    CHUNK_NEXT,
} from '../../lib/firmware.js';
import {loadDeviceDescription} from '../../lib/rftypes.js';
import {BidcosDevice, FT_FIRMWAREUPDATE, FT_WRITE_TRX_REG, CENTRAL_START_BOOTLOADER} from '../../lib/device.js';
import {Air} from '../../lib/air.js';
import {RadioModule} from '../../lib/module.js';
import {encodeTelegram, decodeTelegram, CTRL, FT, ACK, INFO, BROADCAST} from '../../lib/telegram.js';
import {BIDCOS_STATUS, TYPE, SYSTEM, SYSTEM_STATUS} from '../../lib/commands.js';
import {WiredDevice, WCTRL, WIRED_CENTRAL, WIRED_BROADCAST, isBootCtrl} from '../../lib/wired.js';

const RF_FIXTURE = new URL('../fixtures/rftypes/sim_switch.xml', import.meta.url).pathname;
const WIRED_FIXTURE = new URL('../fixtures/hs485types/sim_wired_switch.xml', import.meta.url).pathname;
const CENTRAL = 0x3a2b1c;
const DEVICE = 0x123456;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('update frames: the synthetic layout, the CRC, the .eq3 text and its reading', () => {
    const frames = buildUpdateFrames({typeCode: 0x0011, firmware: 0x2c, frames: 2, size: 100});
    assert.equal(frames.length, 2);
    assert.equal(frames[0].length, 4 + 100 + 2, 'type, firmware, frame count, filler, CRC');
    assert.equal(frames[1].length, 100 + 2);
    assert.deepEqual([...frames[0].subarray(0, 4)], [0x00, 0x11, 0x2c, 2]);
    assert.ok(frames.every(crcOk));
    const spoiled = Buffer.from(frames[1]);
    spoiled[10] ^= 0x01;
    assert.ok(!crcOk(spoiled));
    assert.ok(!crcOk(Buffer.alloc(1)));

    const text = encodeEq3(frames);
    assert.match(text, /^[0-9a-f]+$/, 'hex only, no separators');
    assert.equal(text.length, 4 + 2 * 106 + 4 + 2 * 102);
    assert.equal(text.slice(0, 4), '006a', 'the first frame is 106 bytes long');
    const back = decodeEq3(text);
    assert.equal(back.length, 2);
    assert.deepEqual([...back[0].subarray(0, 2)], [0x00, 0x6a], 'the length bytes rfd sends in front');
    assert.deepEqual(back[0].subarray(2), frames[0]);
    assert.equal(decodeEq3(text.slice(0, -1)), null, 'a frame cut short');
    assert.equal(decodeEq3(text.slice(0, text.length - 2 * 102 - 1)), null, 'a length without its data');
    assert.deepEqual(decodeEq3(''), []);
    assert.equal(encodeEq3(frames, {upper: true}), text.toUpperCase());
});

test("chunksOf: rfd's 50/48/rest split of an update frame", () => {
    const frame = withCrc(Buffer.alloc(200, 0xab));
    const chunks = chunksOf(frame);
    assert.equal(chunks[0].length, CHUNK_FIRST);
    assert.deepEqual([...chunks[0].subarray(0, 2)], [0x00, 202], 'the length in front');
    for (const c of chunks.slice(1, -1)) {
        assert.equal(c.length, CHUNK_NEXT);
    }
    assert.equal(Buffer.concat(chunks).length, 204);
    assert.ok(chunks.at(-1).length <= 2 + CHUNK_NEXT + 2 && chunks.at(-1).length > 0);
    // a small frame goes in one chunk
    assert.equal(chunksOf(withCrc(Buffer.alloc(10))).length, 1);
    assert.equal(chunksOf(withCrc(Buffer.alloc(47))).length, 1, '2 + 49 = 51 bytes: nothing above 52 is left');
    assert.equal(chunksOf(withCrc(Buffer.alloc(49))).length, 2, '2 + 51 = 53 bytes: the first 50, then 3');
});

test('the fwmap, user firmware, hex and wired fwmap writers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmrs-fw-'));
    const frames = buildUpdateFrames({typeCode: 257, firmware: 0x2c, frames: 1, size: 10});
    writeFwmapEntry(dir, {typeCode: 257, version: '2.12', frames, extraLines: ['# comment']});
    writeFwmapEntry(dir, {typeCode: 17, version: '2.5', file: 'sw1.eq3', frames});
    assert.equal(
        fs.readFileSync(path.join(dir, 'fwmap'), 'utf8'),
        '# comment\n257 hmrs_257.eq3 2.12\n17 sw1.eq3 2.5\n',
    );
    assert.equal(fs.readFileSync(path.join(dir, 'hmrs_257.eq3'), 'utf8'), encodeEq3(frames));
    const sub = writeUserFirmware(dir, {name: 'user257', typeCode: 257, version: '2.13', frames});
    assert.equal(fs.readFileSync(path.join(sub, 'info'), 'utf8'), '# user257\nTypeCode=257\nFirmwareVersion=2.13\n');
    assert.ok(fs.existsSync(path.join(sub, 'user257.eq3')));
    writeUserFirmware(dir, {name: 'odd', typeCode: 1, version: '1.0', info: 'x'});
    assert.equal(fs.readFileSync(path.join(dir, 'odd', 'info'), 'utf8'), 'x');

    const image = buildWiredImage({size: 40, version: [3, 6], versionAddress: 0x10});
    assert.deepEqual([...image.subarray(0x10, 0x12)], [6, 3], 'minor, major - little-endian');
    const hex = encodeIntelHex(image, {recordLength: 16});
    const lines = hex.trimEnd().split('\n');
    assert.equal(lines.length, 3 + 1);
    assert.equal(lines[0].slice(0, 9), ':10000000');
    assert.equal(lines[2].slice(0, 9), ':08002000', 'the last record is the 8 remaining bytes at 0x0020');
    assert.equal(lines.at(-1), ':00000001FF');
    for (const line of lines) {
        const bytes = Buffer.from(line.slice(1), 'hex');
        assert.equal(bytes.reduce((a, b) => a + b, 0) & 0xff, 0, `${line} checks to zero`);
    }
    const broken = encodeIntelHex(image, {breakChecksumAt: 1}).split('\n')[1];
    assert.notEqual(Buffer.from(broken.slice(1), 'hex').reduce((a, b) => a + b, 0) & 0xff, 0);
    const extra = encodeIntelHex(image, {extraRecords: [':020000040000FA']}).split('\n');
    assert.equal(extra.at(-3), ':020000040000FA');
    writeWiredFwmapEntry(dir, {key: 'H17V0', version: '@0x10', text: hex});
    assert.equal(fs.readFileSync(path.join(dir, 'fwmap'), 'utf8').split('\n').at(-2), 'H17V0 hmrs_H17V0.hex @0x10');
    fs.rmSync(dir, {recursive: true});
});

function rfDevice(options = {}) {
    return new BidcosDevice({
        address: DEVICE,
        serial: 'SIM0000123',
        description: loadDeviceDescription(RF_FIXTURE),
        typeId: 'SIM-Sw1',
        bootloader: {rebootAfterMs: 20},
        ...options,
    });
}

const startFrame = (counter = 1) =>
    encodeTelegram({
        counter,
        ctrl: CTRL.RPT_ENABLE | CTRL.BIDI,
        type: FT.CENTRAL,
        src: CENTRAL,
        dst: DEVICE,
        payload: [CENTRAL_START_BOOTLOADER],
    });
const trxFrame = (ctrl) =>
    encodeTelegram({counter: 2, ctrl, type: FT_WRITE_TRX_REG, src: CENTRAL, dst: DEVICE, payload: Buffer.alloc(22)});
const updateChunk = (chunk, last, counter = 3) =>
    encodeTelegram({
        counter,
        ctrl: last ? CTRL.BIDI : 0,
        type: FT_FIRMWAREUPDATE,
        src: CENTRAL,
        dst: DEVICE,
        payload: chunk,
    });

/** Sends a whole update frame as rfd would: the chunks, the last one with BIDI; returns the device's answers. */
function sendFrame(device, frame) {
    const chunks = chunksOf(frame);
    let answers = [];
    chunks.forEach((c, i) => {
        answers = device.receive(updateChunk(c, i === chunks.length - 1));
    });
    return answers;
}

test('the BidCoS bootloader: start, INFO_SERIAL, the data rate, the frames, the restart with the new firmware', async () => {
    const device = rfDevice();
    const modes = [];
    device.on('mode', (m) => modes.push(m));
    assert.equal(device.firmware, 0x24);
    // the application refuses the update frame types
    assert.equal(decodeTelegram(device.receive(trxFrame(CTRL.BIDI))[0]).payload[0], ACK.NACK);
    assert.deepEqual(device.receive(trxFrame(0)), []);

    const answers = device.receive(startFrame());
    assert.equal(answers.length, 2);
    assert.equal(decodeTelegram(answers[0]).payload[0], ACK.ACK);
    const info = decodeTelegram(answers[1]);
    assert.equal(info.type, FT.INFO);
    assert.equal(info.dst, BROADCAST, 'receiver 000000 is what rfd reads as "in the bootloader"');
    assert.equal(info.payload[0], INFO.SERIAL);
    assert.equal(info.payload.subarray(1).toString('ascii'), 'SIM0000123');
    assert.equal(device.mode, 'bootloader');
    assert.equal(device.dataRate, 10);

    assert.deepEqual(device.receive(trxFrame(0)), [], 'the first WRITE_TRX_REG asks for no ACK');
    assert.equal(device.dataRate, 100);
    assert.equal(decodeTelegram(device.receive(trxFrame(CTRL.BIDI))[0]).payload[0], ACK.ACK);

    const frames = buildUpdateFrames({typeCode: 0x0011, firmware: 0x2c, frames: 3, size: 120});
    for (const frame of frames) {
        const [ack] = sendFrame(device, frame);
        assert.equal(decodeTelegram(ack).payload[0], ACK.ACK);
    }
    assert.equal(device.updateFrames.length, 3);
    assert.deepEqual(device.updateFrames[1].subarray(2), frames[1]);
    assert.equal(device.mode, 'bootloader', 'still in the bootloader right after the last frame');
    await sleep(60);
    assert.equal(device.mode, 'app');
    assert.equal(device.dataRate, 10);
    assert.equal(device.firmware, 0x2c, 'the firmware byte of frame 0');
    assert.deepEqual(modes, ['bootloader', 'app']);
    assert.equal(decodeTelegram(device.sysinfoTelegram()).payload[0], 0x2c);
});

test('the BidCoS bootloader refuses: a bad CRC, another type, failFrom, a frame cut short; no start when told so', async () => {
    const device = rfDevice({bootloader: {rebootAfterMs: 20, failFrom: 2}});
    device.receive(startFrame());
    const frames = buildUpdateFrames({typeCode: 0x0011, firmware: 0x2c, frames: 3, size: 60});
    const spoiled = Buffer.from(frames[0]);
    spoiled[5] ^= 0xff;
    assert.equal(decodeTelegram(sendFrame(device, spoiled)[0]).payload[0], ACK.NACK);
    assert.deepEqual(device.rejectedFrames, [{index: 0, reason: 'crc'}]);
    const otherType = buildUpdateFrames({typeCode: 0x0012, firmware: 0x2c, frames: 1, size: 60})[0];
    assert.equal(decodeTelegram(sendFrame(device, otherType)[0]).payload[0], ACK.NACK);
    assert.equal(device.rejectedFrames.at(-1).reason, 'type');
    assert.equal(decodeTelegram(sendFrame(device, frames[0])[0]).payload[0], ACK.ACK);
    assert.equal(decodeTelegram(sendFrame(device, frames[1])[0]).payload[0], ACK.ACK);
    assert.equal(decodeTelegram(sendFrame(device, frames[2])[0]).payload[0], ACK.NACK, 'failFrom 2');
    assert.equal(device.rejectedFrames.at(-1).reason, 'refused');
    // a chunk missing: the length does not match (a frame of four chunks, the two middle ones lost)
    const chunks = chunksOf(buildUpdateFrames({typeCode: 0x0011, firmware: 0x2c, frames: 1, size: 150})[0]);
    assert.equal(chunks.length, 4);
    device.receive(updateChunk(chunks[0], false));
    const [nack] = device.receive(updateChunk(chunks.at(-1), true));
    assert.equal(decodeTelegram(nack).payload[0], ACK.NACK);
    assert.equal(device.rejectedFrames.at(-1).reason, 'length');
    assert.equal(device.updateFrames.length, 2);
    assert.equal(device.expectedFrames, 3);
    await sleep(60);
    assert.equal(device.mode, 'bootloader', 'a partial image: the device waits in its bootloader');
    device.leaveBootloader();
    assert.equal(device.mode, 'app');
    assert.equal(device.firmware, 0x2c, 'what frame 0 carried');

    // a type without updatable="true" takes the frame as a plain command (its XML's ENTER_BOOTLOADER, if any)
    const description = loadDeviceDescription(RF_FIXTURE);
    const plain = rfDevice({
        description: {...description, types: description.types.map((x) => ({...x, updatable: false}))},
    });
    assert.equal(plain.updatable, false);
    const [plainAnswer] = plain.receive(startFrame());
    assert.equal(decodeTelegram(plainAnswer).type, FT.ACK_OR_NACK);
    assert.equal(plain.mode, 'app');
    assert.equal(rfDevice().updatable, true);

    const stubborn = rfDevice({bootloader: {startsOnCommand: false}});
    const [answer] = stubborn.receive(startFrame());
    assert.equal(decodeTelegram(answer).payload[0], ACK.NACK);
    assert.equal(stubborn.mode, 'app');
    const quiet = rfDevice({bootloader: {announces: false, ackUpdateFrames: false, rebootAfterMs: 20}});
    assert.equal(quiet.receive(startFrame()).length, 1, 'the ACK alone');
    assert.deepEqual(sendFrame(quiet, frames[0]), [], 'silent: the frame did not reach it');
    assert.equal(quiet.updateFrames.length, 0);
});

test('the air: a device at 100 kbit/s hears only a module at 100 kbit/s', async () => {
    const module = new RadioModule({sendDelayMs: 1, ackDelayMs: 1, failDelayMs: 3});
    const air = new Air({module});
    const device = air.add(rfDevice());
    const send = (raw) => air.send({waitMs: 0, burst: 0, telegram: decodeTelegram(raw), raw: Buffer.from(raw)}, module);
    const started = await send(startFrame());
    assert.equal(started.status, BIDCOS_STATUS.TELEGRAM_SENT_RECVD_ACK);
    assert.equal(device.mode, 'bootloader');
    assert.equal((await send(trxFrame(0))).status, BIDCOS_STATUS.TELEGRAM_SENT, 'at 10 kbit/s, no ACK asked');
    assert.equal(device.dataRate, 100);
    assert.equal(module.dataRate, 10);
    assert.equal(
        (await send(trxFrame(CTRL.BIDI))).status,
        BIDCOS_STATUS.SEND_FAILED,
        'the module is still at 10 kbit/s: the device does not hear it',
    );
    // SET_100K_DATARATE on the module
    const written = [];
    module.writeFrame = (payload) => written.push(Buffer.from(payload));
    module.handleFrame(Buffer.from([TYPE.SYSTEM, 7, SYSTEM.SET_100K_DATARATE, 0xe9, 0xca]));
    await sleep(5);
    assert.equal(module.dataRate, 100);
    assert.deepEqual([...written[0]], [TYPE.SYSTEM, 7, SYSTEM.RESPONSE_STATUS, SYSTEM_STATUS.OK]);
    assert.equal((await send(trxFrame(CTRL.BIDI))).status, BIDCOS_STATUS.TELEGRAM_SENT_RECVD_ACK);
    assert.ok(
        air.traceLines().some((l) => l === 'tx WRITE_TRX_REG [bidi] @100k'),
        air.traceLines().join(' | '),
    );
    module.handleFrame(Buffer.from([TYPE.SYSTEM, 8, SYSTEM.SET_10K_DATARATE]));
    assert.equal(module.dataRate, 10);
    assert.ok(air.traceLines().includes('tx START_BOOTLOADER [bidi]'));
});

function wiredDevice(options = {}) {
    return new WiredDevice({
        address: 0x00001234,
        serial: 'SIMW000001',
        description: loadDeviceDescription(WIRED_FIXTURE),
        typeId: 'HMW-LC-Sw2-DR',
        sysinfo: [0x11, 0x00, 0x03, 0x05],
        bootloader: {pageSize: 128, flashSize: 1024, versionAddress: 0x3fe},
        ...options,
    });
}

const boot = (device, payload) => device.handle(WIRED_CENTRAL, WCTRL.BOOT_IFRAME, Buffer.from(payload), false);

test('the wired bootloader: u, p, w, r, g; the version from the flash; the fault knobs', () => {
    assert.ok(isBootCtrl(0x10) && !isBootCtrl(0x18) && !isBootCtrl(0x19) && !isBootCtrl(0x98));
    const device = wiredDevice();
    assert.equal(boot(device, [0x70]), null, 'the application ignores bootloader frames');
    const entered = device.handle(WIRED_CENTRAL, WCTRL.IFRAME | WCTRL.SYN, Buffer.from('u'), false);
    assert.equal(entered.ctrl, WCTRL.ACK);
    assert.equal(device.mode, 'bootloader');
    assert.equal(boot(device, 'u').ctrl, WCTRL.ACK);
    assert.deepEqual([...boot(device, 'p').data], [0x00, 0x80]);
    const image = buildWiredImage({size: 1024, version: [3, 6], versionAddress: 0x3fe});
    for (let at = 0; at < 1024; at += 128) {
        const answer = boot(
            device,
            Buffer.concat([Buffer.from([0x77, at >> 8, at & 0xff, 128]), image.subarray(at, at + 128)]),
        );
        assert.equal(answer.ctrl, WCTRL.ACK);
    }
    assert.deepEqual(device.flash.subarray(0, 1024), image);
    const read = boot(device, [0x72, 0x00, 0x80, 128]);
    assert.deepEqual(read.data, image.subarray(0x80, 0x100));
    assert.equal(
        device.handle(WIRED_CENTRAL, WCTRL.BOOT_IFRAME, Buffer.from('z'), true),
        null,
        'broadcasts unanswered',
    );
    assert.equal(boot(device, 'g').ctrl, WCTRL.ACK);
    assert.equal(device.mode, 'app');
    assert.deepEqual([...device.sysinfo], [0x11, 0x00, 0x03, 0x06], 'the version word at 0x3fe: 06 03');
    assert.deepEqual(device.bootCommands.slice(0, 4), ['u', 'u', 'p', 'w@0000']);
    assert.ok(device.bootCommands.includes('r@0080'));
    assert.equal(device.bootCommands.at(-1), 'g');
    // a size byte of 0 means 256
    const big = wiredDevice({bootloader: {pageSize: 256, flashSize: 1024}});
    big.handle(WIRED_CENTRAL, WCTRL.IFRAME, Buffer.from('u'), false);
    boot(big, Buffer.concat([Buffer.from([0x77, 0x00, 0x00, 0x00]), Buffer.alloc(256, 0x5a)]));
    assert.ok(big.flash.subarray(0, 256).every((b) => b === 0x5a) && big.flash[256] === 0xff);

    const stubborn = wiredDevice({bootloader: {entersOnCommand: false}});
    assert.equal(stubborn.handle(WIRED_CENTRAL, WCTRL.IFRAME, Buffer.from('u'), false).ctrl, WCTRL.ACK);
    assert.equal(stubborn.mode, 'app');
    assert.equal(boot(stubborn, 'u'), null);
    const zero = wiredDevice({bootloader: {pageSizeAnswer: [0, 0]}});
    zero.handle(WIRED_CENTRAL, WCTRL.IFRAME, Buffer.from('u'), false);
    assert.deepEqual([...boot(zero, 'p').data], [0, 0]);
    const spoiling = wiredDevice({bootloader: {corruptWriteAt: 0x85, flashSize: 1024}});
    spoiling.handle(WIRED_CENTRAL, WCTRL.IFRAME, Buffer.from('u'), false);
    boot(spoiling, Buffer.concat([Buffer.from([0x77, 0x00, 0x80, 128]), image.subarray(0x80, 0x100)]));
    assert.equal(spoiling.flash[0x85], image[0x85] ^ 0xff);
    assert.equal(spoiling.flash[0x86], image[0x86]);
    assert.equal(WIRED_BROADCAST, 0xffffffff);
});
