import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

import {encodeRequest, encodeValue, encodeDouble, malformedRequests, BT} from '../../lib/binrpc-raw.js';

const require = createRequire(import.meta.url);
const protocol = require('binrpc/lib/protocol.js');

test('encodeRequest matches the binrpc reference encoder', () => {
    const cases = [
        ['system.listMethods', []],
        ['setValue', ['LEQ0134153:1', 'STATE', true]],
        ['putParamset', ['ABC:0', 'MASTER', {A: 1, B: 'x', C: [1, 2]}]],
        ['getValue', ['X:1', 'LEVEL', 0.5]],
    ];
    for (const [method, params] of cases) {
        const mine = encodeRequest(method, params);
        const reference = protocol.encodeRequest(method, params);
        assert.deepEqual([...mine], [...reference], method);
    }
});

test('doubles use the mantissa/exponent form', () => {
    assert.deepEqual([...encodeDouble(0.5)], [...protocol.encodeData(0.5)]);
    assert.deepEqual([...encodeValue({double: 2})], [...protocol.encodeData({explicitDouble: 2})]);
});

test('malformed requests all have a well-formed outer header and a unique name', () => {
    const list = malformedRequests();
    assert.ok(list.length >= 8);
    const names = new Set();
    for (const {name, bytes} of list) {
        assert.equal(bytes.subarray(0, 3).toString('ascii'), 'Bin', name);
        assert.ok(!names.has(name), `duplicate ${name}`);
        names.add(name);
    }
});

test('type constants', () => {
    assert.equal(BT.STRUCT, 0x101);
    assert.deepEqual([...encodeValue(true)], [0, 0, 0, 2, 1]);
});
