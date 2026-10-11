import {test} from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import {Eq3LanDevice, parseRequest, typeMatches} from '../../lib/eq3udp.js';

function request(typeFilter, serial, opcode, counter = 7) {
    return Buffer.concat([
        Buffer.from([0x02, 0xaa, 0xbb, 0xcc, counter]),
        Buffer.from(`${typeFilter}\0${serial}\0${opcode}`, 'latin1'),
    ]);
}

async function ask(device, bytes) {
    const socket = dgram.createSocket('udp4');
    await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
    const answer = new Promise((resolve) => {
        socket.once('message', (m) => resolve(m));
        setTimeout(() => resolve(null), 1500);
    });
    socket.send(bytes, device.port, '127.0.0.1');
    const result = await answer;
    socket.close();
    return result;
}

test('the request parser and the type filter', () => {
    const r = parseRequest(request('eQ3-HM-LGW*', 'ABC0000001', 'I'));
    assert.equal(r.typeFilter, 'eQ3-HM-LGW*');
    assert.equal(r.serial, 'ABC0000001');
    assert.equal(r.opcode, 'I');
    assert.equal(r.counter, 7);
    assert.deepEqual([...r.senderId], [0xaa, 0xbb, 0xcc]);
    assert.equal(parseRequest(Buffer.from('hello')), null);
    assert.ok(typeMatches('eQ3-HM-LGW*', 'eQ3-HM-LGW'));
    assert.ok(typeMatches('', 'eQ3-HMW-LGW'));
    assert.ok(!typeMatches('eQ3-HM-LGW*', 'eQ3-HMW-LGW'));
    assert.ok(typeMatches('eQ3-HMW-LGW', 'eQ3-HMW-LGW'));
});

test('the LAN device answers identify and the runtime IP configuration in the eQ3Config shape', async () => {
    const device = new Eq3LanDevice({
        type: 'eQ3-HMW-LGW',
        serial: 'SIMWLGW001',
        firmware: '1.0.2',
        ip: '127.0.0.1',
        services: [[1, 1000]],
        port: 0,
        bind: '127.0.0.1',
    });
    await device.start();
    try {
        const identify = await ask(device, request('eQ3-HMW-LGW*', '', 'I'));
        assert.ok(identify, 'an answer');
        // header: 02, the sender's id and counter, then the device's type and serial
        assert.deepEqual([...identify.subarray(0, 5)], [0x02, 0xaa, 0xbb, 0xcc, 7]);
        const text = identify.subarray(5).toString('latin1');
        assert.ok(text.startsWith('eQ3-HMW-LGW\0SIMWLGW001\0>I\x01' + '1.0.2\0'), JSON.stringify(text));
        const tail = identify.subarray(identify.length - 6);
        assert.deepEqual([...tail], [0x00, 0x01, 0x03, 0xe8, 0x00, 0x00], 'service 1 on port 1000, then the end');
        const config = await ask(device, request('', 'SIMWLGW001', 'n'));
        const data = config.subarray(config.indexOf('>n', 5, 'latin1') + 3);
        assert.deepEqual([...data.subarray(0, 4)], [127, 0, 0, 1], 'the ip');
        assert.equal(data.length, 20, 'ip, gateway, netmask, two dns');
        assert.equal(await ask(device, request('eQ3-HM-LGW*', '', 'I')), null, 'another type is not answered');
        assert.equal(await ask(device, request('', 'OTHER', 'I')), null, 'another serial is not answered');
        assert.equal(device.requests.length, 4);
        assert.equal(device.requests.filter((r) => r.answered).length, 2);
    } finally {
        await device.close();
    }
});

test('a serial in another letter case is answered only with serialIgnoringCase', async () => {
    for (const serialIgnoringCase of [false, true]) {
        const device = new Eq3LanDevice({
            type: 'eQ3-HM-LGW',
            serial: 'SIM0000002',
            ip: '127.0.0.1',
            port: 0,
            bind: '127.0.0.1',
            serialIgnoringCase,
        });
        await device.start();
        try {
            const answer = await ask(device, request('eQ3-HM-LGW*', 'sim0000002', 'I'));
            assert.equal(answer !== null, serialIgnoringCase);
            assert.equal(device.requests[0].serial, 'sim0000002');
        } finally {
            await device.close();
        }
    }
});
