import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
    challengeFrame,
    responseFrame,
    verifyResponse,
    signedAckFrame,
    verifySignature,
    isChallenge,
    sessionKey,
} from '../../lib/aes.js';
import {encodeTelegram, decodeTelegram, FT, ACK} from '../../lib/telegram.js';

const KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

test('the AES handshake round-trips: challenge, response, verification, signed acknowledgement', () => {
    const m = decodeTelegram(
        encodeTelegram({
            counter: 0x2a,
            ctrl: 0xa0,
            type: 0x11,
            src: 0x3a2b1c,
            dst: 0x123456,
            payload: [0x02, 0x01, 0xc8, 0, 0],
        }),
    );
    const {telegram: c, challenge} = challengeFrame(m, 1);
    assert.ok(isChallenge(c));
    const cd = decodeTelegram(c);
    assert.equal(cd.type, FT.ACK_OR_NACK);
    assert.equal(cd.payload[0], ACK.ACK_W_AES_CHALLENGE);
    assert.equal(cd.payload[7], 1, 'the key index');
    assert.equal(cd.counter, 0x2a, 'the challenge repeats the counter');

    const {telegram: r, pd} = responseFrame(KEY, challenge, m);
    const rd = decodeTelegram(r);
    assert.equal(rd.type, FT.AES_SOLUTION);
    assert.equal(rd.payload.length, 16);
    const check = verifyResponse(KEY, challenge, m, rd.payload);
    assert.ok(check.ok, 'the device recovers the block and finds its frame in it');
    assert.ok(check.pd.equals(pd), 'both sides hold the same pd');

    const a = signedAckFrame(m, check.pd);
    assert.ok(verifySignature(a, pd), 'the signature matches');
    assert.deepEqual([...decodeTelegram(a).payload.subarray(0, 1)], [ACK.ACK]);
});

test('a wrong key, a tampered frame or a wrong signature fail the handshake', () => {
    const m = decodeTelegram(
        encodeTelegram({counter: 1, ctrl: 0xa0, type: 0x11, src: 0x3a2b1c, dst: 0x123456, payload: [0x02, 0x01, 0]}),
    );
    const {challenge} = challengeFrame(m, 1);
    const {telegram: r, pd} = responseFrame(KEY, challenge, m);
    const rd = decodeTelegram(r);
    const other = Buffer.from(KEY);
    other[15] ^= 1;
    assert.equal(verifyResponse(other, challenge, m, rd.payload).ok, false, 'another key');
    const tampered = {...m, payload: Buffer.from([0x02, 0x01, 0xc8])};
    assert.equal(verifyResponse(KEY, challenge, tampered, rd.payload).ok, false, 'another M frame');
    const badAck = encodeTelegram({counter: 1, type: 0x02, src: 0x123456, dst: 0x3a2b1c, payload: [0, 1, 2, 3, 4]});
    assert.equal(verifySignature(badAck, pd), false);
    assert.equal(sessionKey(KEY, Buffer.alloc(6)).equals(KEY), true, 'a zero challenge leaves the key');
    assert.notEqual(sessionKey(KEY, crypto.randomBytes(6)).toString('hex'), KEY.toString('hex'));
});
