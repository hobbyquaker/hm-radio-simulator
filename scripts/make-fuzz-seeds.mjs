#!/usr/bin/env node
/**
 * Writes seed inputs for the fuzz harnesses: valid BIN-RPC and XML-RPC requests, small XML documents, the module's and
 * the HMW-LGW's frames, configuration, hex, update and JSON files - so that the coverage-guided fuzzers start from the
 * real formats. Usage: make-fuzz-seeds.mjs <output dir>
 */
import fs from 'node:fs';
import path from 'node:path';

import {encodeRequest, encodeResponse, encodeValue} from '../lib/binrpc-raw.js';
import {encodeFrame} from '../lib/frame.js';
import {encodeTransportFrame} from '../lib/hmwlgw.js';

const out = process.argv[2];
if (!out) {
    console.error('usage: make-fuzz-seeds.mjs <output dir>');
    process.exit(2);
}

function write(harness, name, bytes) {
    const dir = path.join(out, harness);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, name), bytes);
}

const xmlCall = (method, paramsXml) =>
    `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${paramsXml}</params></methodCall>`;
const p = (valueXml) => `<param><value>${valueXml}</value></param>`;

// fuzz_xmlrpc_value: single values, binary and XML
write('fuzz_xmlrpc_value', 'int', encodeValue(42));
write('fuzz_xmlrpc_value', 'string', encodeValue('LEQ0134153:1'));
write('fuzz_xmlrpc_value', 'double', encodeValue(0.75));
write(
    'fuzz_xmlrpc_value',
    'struct',
    encodeValue({ADDRESS: 'ABC:1', TYPE: 'SWITCH', STATE: true, LEVEL: 0.5, LIST: [1, 2, 3]}),
);
write('fuzz_xmlrpc_value', 'array', encodeValue([[1, 'a'], {x: false}]));
write(
    'fuzz_xmlrpc_value',
    'xml-struct',
    Buffer.from('<value><struct><member><name>a</name><value><int>1</int></value></member></struct></value>'),
);
write(
    'fuzz_xmlrpc_value',
    'xml-array',
    Buffer.from(
        '<value><array><data><value><string>x</string></value><value><boolean>1</boolean></value></data></array></value>',
    ),
);
write('fuzz_xmlrpc_value', 'xml-base64', Buffer.from('<value><base64>SGVsbG8=</base64></value>'));

// fuzz_xmlrpc_request: first byte selects binary (odd) or xml (even)
const bin = (bytes) => Buffer.concat([Buffer.from([1]), bytes]);
const xml = (text) => Buffer.concat([Buffer.from([0]), Buffer.from(text)]);
write('fuzz_xmlrpc_request', 'bin-listmethods', bin(encodeRequest('system.listMethods', [])));
write('fuzz_xmlrpc_request', 'bin-echo', bin(encodeRequest('echo', ['ABC:1', 'STATE', true, 0.5, {a: 1}])));
write('fuzz_xmlrpc_request', 'bin-methodhelp', bin(encodeRequest('system.methodHelp', ['echo'])));
write(
    'fuzz_xmlrpc_request',
    'bin-multicall',
    bin(
        encodeRequest('system.multicall', [
            [
                {methodName: 'echo', params: [1]},
                {methodName: 'system.listMethods', params: []},
            ],
        ]),
    ),
);
write(
    'fuzz_xmlrpc_request',
    'bin-nested-multicall',
    bin(
        encodeRequest('system.multicall', [
            [{methodName: 'system.multicall', params: [[{methodName: 'echo', params: [1]}]]}],
        ]),
    ),
);
write('fuzz_xmlrpc_request', 'bin-response', bin(encodeResponse(['a', 1])));
write('fuzz_xmlrpc_request', 'xml-listmethods', xml(xmlCall('system.listMethods', '')));
write(
    'fuzz_xmlrpc_request',
    'xml-echo',
    xml(xmlCall('echo', p('<string>ABC:1</string>') + p('<boolean>1</boolean>') + p('<double>0.5</double>'))),
);
write(
    'fuzz_xmlrpc_request',
    'xml-multicall',
    xml(
        xmlCall(
            'system.multicall',
            p(
                '<array><data><value><struct><member><name>methodName</name><value><string>echo</string></value></member>' +
                    '<member><name>params</name><value><array><data><value><int>1</int></value></data></array></value></member></struct></value></data></array>',
            ),
        ),
    ),
);

// fuzz_xmlparser: small documents of the shapes the device descriptions use
write(
    'fuzz_xmlparser',
    'device',
    Buffer.from(
        '<?xml version="1.0" encoding="iso-8859-1"?>\n<device version="1" rx_modes="CONFIG"><supported_types><type name="X" id="X"><parameter index="10.0" size="2.0" const_value="1"/></type></supported_types>' +
            '<paramset type="MASTER" id="m"><parameter id="A"><logical type="integer" min="0" max="255" default="1"/><physical type="integer" interface="config" list="0" index="1" size="1"/></parameter></paramset>' +
            '<frames><frame id="F" direction="from_device" type="0x10" channel_field="10"><parameter type="integer" index="11.0" size="1.0" param="LEVEL"/></frame></frames></device>\n',
    ),
);
write(
    'fuzz_xmlparser',
    'comment-cdata',
    Buffer.from('<a b="1" c=\'2\'><!-- comment --><![CDATA[ raw <text> ]]><d/><e>text &amp; entity</e></a>'),
);
write(
    'fuzz_xmlparser',
    'pi-doctype',
    Buffer.from('<?xml version="1.0"?><!DOCTYPE x><x xmlns:p="urn:p"><p:y p:z="w"/></x>'),
);
write('fuzz_xmlparser', 'deep', Buffer.from('<a>'.repeat(40) + 'x' + '</a>'.repeat(40)));

// fuzz_xmlparser_edit: control bytes, a 0x00, the document
write(
    'fuzz_xmlparser_edit',
    'add',
    Buffer.concat([
        Buffer.from([0, 0, 1, 0, 2, 1, 3, 0, 4, 0, 5, 1, 6, 0, 0]),
        Buffer.from('<device version="1"><channels><channel index="0"/></channels></device>'),
    ]),
);
write(
    'fuzz_xmlparser_edit',
    'long-name',
    Buffer.concat([Buffer.from([0xf0, 0, 0xf1, 0, 0]), Buffer.from('<a><b c="d"/></a>')]),
);

// fuzz_ccu2_frame: a chunk size byte, then module frames (identify, a version answer, a BidCoS event, a duty-cycle event)
const moduleFrames = Buffer.concat([
    encodeFrame(Buffer.from([0x00, 0x00, 0x00, ...Buffer.from('Co_CPU_App')])),
    encodeFrame(Buffer.from([0x00, 0x01, 0x04, 0x02, 0x01, 0x00, 0x0c, 0x02, 0x08, 0x06])),
    encodeFrame(
        Buffer.from([
            0x01, 0x05, 0x05, 0x10, 0x01, 0x40, 0x12, 0x86, 0x10, 0x12, 0x34, 0x56, 0x3a, 0x2b, 0x1c, 0x06, 0x01, 0xc8,
            0x00,
        ]),
    ),
    encodeFrame(Buffer.from([0x00, 0x06, 0x05, 0x14])),
    encodeFrame(
        Buffer.from([
            0x01, 0x07, 0x04, 0x03, 0x01, 0x37, 0x01, 0x80, 0x02, 0x12, 0x34, 0x56, 0x3a, 0x2b, 0x1c, 0x01, 0x01, 0xc8,
            0x00,
        ]),
    ),
]);
write('fuzz_ccu2_frame', 'frames-whole', Buffer.concat([Buffer.from([63]), moduleFrames]));
write('fuzz_ccu2_frame', 'frames-bytewise', Buffer.concat([Buffer.from([0]), moduleFrames]));
write(
    'fuzz_ccu2_frame',
    'escaped',
    Buffer.concat([Buffer.from([7]), encodeFrame(Buffer.from([0x01, 0xfc, 0x05, 0xfd, 0x00, 0x40]))]),
);

// fuzz_hmwlgw_frame: a chunk size byte, then gateway frames ('a' 00, 'r' with data, 'e' event, 'c' end of discovery)
const lgwFrames = Buffer.concat([
    encodeTransportFrame(Buffer.from([0x01, 0x61, 0x00])),
    encodeTransportFrame(
        Buffer.from([0x02, 0x72, 0x00, 0x00, 0x00, 0x01, 0x18, 0x00, 0x00, 0x00, 0x00, 0x69, 0x03, 0xc8]),
    ),
    encodeTransportFrame(
        Buffer.from([0x03, 0x65, 0x00, 0x00, 0x00, 0x01, 0x98, 0x00, 0x00, 0x00, 0x00, 0x4b, 0x01, 0x02]),
    ),
    encodeTransportFrame(Buffer.from([0x04, 0x63, 0x00, 0x00, 0x01])),
]);
write('fuzz_hmwlgw_frame', 'frames-whole', Buffer.concat([Buffer.from([63]), lgwFrames]));
write('fuzz_hmwlgw_frame', 'frames-bytewise', Buffer.concat([Buffer.from([0]), lgwFrames]));

// the file formats
write(
    'fuzz_propertymap',
    'rfd-conf',
    Buffer.from('Listen Port = 2001\nLog Level = 1\n\n[Interface 0]\nType = CCU2\nComPortFile = /dev/mmd_bidcos\n'),
);
write(
    'fuzz_propertymap',
    'keys',
    Buffer.from('Current Index = 1\nLast Index = 1\nKey 1 = 00112233445566778899aabbccddeeff\n'),
);
write(
    'fuzz_hexfile',
    'firmware',
    Buffer.from(
        ':10010000214601360121470136007EFE09D2190140\n:100110002146017E17C20001FF5F16002148011928\n:00000001FF\n',
    ),
);
write('fuzz_updatefile', 'frames', Buffer.from('000401020304000201FF'));
write('fuzz_json', 'user-color', Buffer.from('{"ACT_HSV_COLOR_VALUE":"200","ACT_BRIGHTNESS":"100","RAMP_TIME":"0.5"}'));
write('fuzz_json', 'nested', Buffer.from('{"a":{"b":2},"c":[1,2],"d":true}'));

console.log(`seeds written to ${out}`);
