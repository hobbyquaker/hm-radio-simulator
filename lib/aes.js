/**
 * The BidCoS AES handshake between a central (here: the simulated module, which runs it in firmware on real
 * hardware) and an AES-secured device, as public documentation describes it (Homegear's AesHandshake.cpp and FHEM's
 * CUL_HM, read as documentation; no code copied):
 *
 *   1. The central sends a command (the M frame). The device answers with a challenge instead of an ACK:
 *      the C frame, type 0x02, payload `04 c1 c2 c3 c4 c5 c6 00` (six random bytes, then the key index's low byte).
 *   2. The central derives a session key: the 16-byte key with its first six bytes XORed with the challenge, and
 *      builds a 16-byte block `pdd` = six random bytes, the M frame's counter, control byte & 0xBF, type, source (3),
 *      destination (3) and first payload byte. It encrypts `pdd` (AES-128-ECB) to `pd`, XORs `pd` with the M frame's
 *      payload from its second byte on, encrypts again and sends the result as the R frame, type 0x03, 16 bytes.
 *   3. The device decrypts the R frame, undoes the XOR, decrypts again and compares the recovered `pdd` with the M
 *      frame it saw. On a match it acknowledges with the A frame: type 0x02, payload `00` + the first four bytes of
 *      `pd` (the signature); the central checks them against its own `pd`.
 *
 * The module reports the outcome to rfd as AUTHENTICATION_SUCCESS (with the key index, RSSI and the A frame) or
 * AUTHENTICATION_FAILURE; rfd sets the keys and the per-device policy and reads the result.
 */

import crypto from 'node:crypto';
import {encodeTelegram, decodeTelegram, CTRL, FT, ACK} from './telegram.js';

const ECB = 'aes-128-ecb';

function ecb(key, block, encrypt) {
    const c = encrypt ? crypto.createCipheriv(ECB, key, null) : crypto.createDecipheriv(ECB, key, null);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(block), c.final()]);
}

/**
 * @param {Buffer} key the 16-byte key
 * @param {Uint8Array} challenge the six challenge bytes
 */
export function sessionKey(key, challenge) {
    const out = Buffer.from(key);
    for (let i = 0; i < 6; i++) {
        out[i] ^= challenge[i];
    }
    return out;
}

/**
 * The device's challenge to a command frame.
 * @param {object} m the decoded M frame (decodeTelegram)
 * @param {number} keyIndex the key index the device uses
 * @param {Buffer} [challenge] six bytes (random when omitted)
 * @returns {{telegram: Buffer, challenge: Buffer}}
 */
export function challengeFrame(m, keyIndex, challenge = crypto.randomBytes(6)) {
    const telegram = encodeTelegram({
        counter: m.counter,
        ctrl: CTRL.RPT_ENABLE | CTRL.BIDI,
        type: FT.ACK_OR_NACK,
        src: m.dst,
        dst: m.src,
        payload: Buffer.concat([Buffer.from([ACK.ACK_W_AES_CHALLENGE]), challenge, Buffer.from([keyIndex & 0xff])]),
    });
    return {telegram, challenge: Buffer.from(challenge)};
}

/** The 16-byte block that binds the response to the M frame. */
function block(m, random6) {
    const p = Buffer.alloc(16);
    random6.copy(p, 0, 0, 6);
    p[6] = m.counter;
    p[7] = m.ctrl & 0xbf;
    p[8] = m.type;
    p.writeUIntBE(m.src & 0xffffff, 9, 3);
    p.writeUIntBE(m.dst & 0xffffff, 12, 3);
    p[15] = m.payload.length ? m.payload[0] : 0;
    return p;
}

/**
 * The central's response to a challenge.
 * @param {Buffer} key the 16-byte key of the index the device named
 * @param {Buffer} challenge the six challenge bytes
 * @param {object} m the decoded M frame the challenge answers
 * @param {Buffer} [random6]
 * @returns {{telegram: Buffer, pd: Buffer}} the R frame and the central's `pd` (its first four bytes are the signature)
 */
export function responseFrame(key, challenge, m, random6 = crypto.randomBytes(6)) {
    const k = sessionKey(key, challenge);
    const pd = ecb(k, block(m, random6), true);
    const mixed = Buffer.from(pd);
    for (let i = 0; i < 16 && i + 1 < m.payload.length; i++) {
        mixed[i] ^= m.payload[i + 1];
    }
    const r = ecb(k, mixed, true);
    return {
        telegram: encodeTelegram({
            counter: m.counter,
            ctrl: CTRL.RPT_ENABLE,
            type: FT.AES_SOLUTION,
            src: m.src,
            dst: m.dst,
            payload: r,
        }),
        pd,
    };
}

/**
 * The device's check of the R frame against the M frame it saw.
 * @param {Buffer} key
 * @param {Buffer} challenge
 * @param {object} m the decoded M frame
 * @param {Uint8Array} rPayload the 16 bytes of the R frame
 * @returns {{ok: boolean, pd: Buffer|null}} with `pd` the recovered block (its first four bytes are the signature)
 */
export function verifyResponse(key, challenge, m, rPayload) {
    if (rPayload.length !== 16) {
        return {ok: false, pd: null};
    }
    const k = sessionKey(key, challenge);
    const mixed = ecb(k, Buffer.from(rPayload), false);
    const pd = Buffer.from(mixed);
    for (let i = 0; i < 16 && i + 1 < m.payload.length; i++) {
        pd[i] ^= m.payload[i + 1];
    }
    const pdd = ecb(k, pd, false);
    const expected = block(m, pdd.subarray(0, 6));
    return {ok: pdd.subarray(6).equals(expected.subarray(6)), pd};
}

/**
 * The device's A frame: the acknowledgement that carries the signature.
 * @param {object} m the decoded M frame
 * @param {Buffer} pd the recovered block
 */
export function signedAckFrame(m, pd) {
    return encodeTelegram({
        counter: m.counter,
        ctrl: CTRL.RPT_ENABLE,
        type: FT.ACK_OR_NACK,
        src: m.dst,
        dst: m.src,
        payload: Buffer.concat([Buffer.from([ACK.ACK]), pd.subarray(0, 4)]),
    });
}

/**
 * The central's check of the A frame's signature.
 * @param {Uint8Array} aTelegram
 * @param {Buffer} pd the central's own `pd`
 */
export function verifySignature(aTelegram, pd) {
    const a = decodeTelegram(aTelegram);
    return (
        !!a && a.type === FT.ACK_OR_NACK && a.payload.length >= 5 && a.payload.subarray(1, 5).equals(pd.subarray(0, 4))
    );
}

/** Whether a telegram is a device's AES challenge (ACK_W_AES_CHALLENGE). */
export function isChallenge(telegram) {
    const t = decodeTelegram(telegram);
    return !!t && t.type === FT.ACK_OR_NACK && t.payload[0] === ACK.ACK_W_AES_CHALLENGE && t.payload.length >= 8;
}

/**
 * The CBC-MAC some BidCoS sensors append to their events instead of the challenge-response (`aes_cbc` channels in
 * the rftypes XML), as rfd checks it (OpenCCU-Base RFChannel::performCBCAuthentification, read as documentation):
 * a 24-bit counter whose low byte is the telegram's counter byte and whose high and middle bytes follow the payload,
 * then a 4-byte MIC. With the device's 16-byte key K:
 *
 *     b0  = 49 | sender (3) | receiver (3) | counter (3) | 00 00 00 00 00 | 05
 *     b1  = counter byte | control byte | the payload without counter and MIC (at most 14 bytes, zero-padded)
 *     MIC = last 4 bytes of AES-ECB(K, AES-ECB(K, b0) XOR b1)
 *
 * @param {Buffer} key the 16-byte key
 * @param {Uint8Array} telegram the telegram without the appended counter and MIC
 * @param {number} counter the 24-bit counter
 * @returns {Buffer} the 4-byte MIC
 */
export function cbcMic(key, telegram, counter) {
    const t = Buffer.from(telegram);
    const b0 = Buffer.alloc(16);
    b0[0] = 0x49;
    t.copy(b0, 1, 3, 6);
    t.copy(b0, 4, 6, 9);
    b0.writeUIntBE(counter & 0xffffff, 7, 3);
    b0[15] = 0x05;
    const b1 = Buffer.alloc(16);
    b1[0] = counter & 0xff;
    b1[1] = t[1];
    t.subarray(9, 9 + 14).copy(b1, 2);
    const x = ecb(key, b0, true);
    for (let i = 0; i < 16; i++) {
        x[i] ^= b1[i];
    }
    return ecb(key, x, true).subarray(12, 16);
}

/**
 * A telegram signed the CBC way: the counter's low byte as the telegram counter, its high and middle bytes and the
 * MIC appended.
 * @param {Buffer} key
 * @param {Uint8Array} telegram
 * @param {number} counter 24 bits
 * @param {{badMic?: boolean}} [options] `badMic` flips a bit of the MIC
 * @returns {Buffer}
 */
export function cbcSign(key, telegram, counter, {badMic = false} = {}) {
    const t = Buffer.from(telegram);
    t[0] = counter & 0xff;
    const mic = Buffer.from(cbcMic(key, t, counter));
    if (badMic) {
        mic[3] ^= 0x01;
    }
    return Buffer.concat([t, Buffer.from([(counter >> 16) & 0xff, (counter >> 8) & 0xff]), mic]);
}
