#!/usr/bin/env node
/**
 * Writes seed inputs for the fuzz harnesses: valid BIN-RPC and XML-RPC requests and small XML documents, so that the
 * coverage-guided fuzzers start from the real formats. Usage: make-fuzz-seeds.mjs <output dir>
 */
import fs from 'node:fs';
import path from 'node:path';

import {encodeRequest, encodeResponse, encodeValue} from '../lib/binrpc-raw.js';

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

console.log(`seeds written to ${out}`);
