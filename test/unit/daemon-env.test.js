import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {combineEnv} from '../helpers/daemon.js';

test('combineEnv: later values win, LD_PRELOAD and the sanitizer options are joined', () => {
    const env = combineEnv(
        {LD_PRELOAD: '/opt/hmrs/libhmrs-faults.so', ASAN_OPTIONS: 'detect_leaks=0', TZ: 'Europe/Berlin'},
        {LD_PRELOAD: '/usr/lib/faketime/libfaketime.so.1', ASAN_OPTIONS: 'verify_asan_link_order=0', TZ: 'UTC'},
        {FAKETIME: '+49d', UNSET: undefined},
    );
    assert.deepEqual(env, {
        LD_PRELOAD: '/opt/hmrs/libhmrs-faults.so:/usr/lib/faketime/libfaketime.so.1',
        ASAN_OPTIONS: 'detect_leaks=0:verify_asan_link_order=0',
        TZ: 'UTC',
        FAKETIME: '+49d',
    });
    assert.deepEqual(combineEnv(), {});
    assert.deepEqual(combineEnv({LD_PRELOAD: '/a.so'}), {LD_PRELOAD: '/a.so'});
});

test('sanitizer reports: ThreadSanitizer reports of known races are set apart, a new race stays (test/metadata.js signatures)', async () => {
    const {FINDINGS} = await import('../metadata.js');
    const {knownRaceOf} = await import('../helpers/known.js');
    const ulc =
        'SUMMARY: ThreadSanitizer: data race /openccu-base/src/libUnifiedLanComm/src/UnifiedLanCommController.cpp:203 in ulc::UnifiedLanCommController::stopReceiveThread()';
    const wrapper =
        'SUMMARY: ThreadSanitizer: data race /openccu-base/src/rfd/hm2/LGWPortWrapper.cpp:108 in HM2::LGWPortWrapper::ReadData(std::string&, unsigned int)';
    const other = 'SUMMARY: ThreadSanitizer: data race /openccu-base/src/rfd/RFDevice.cpp:10 in RFDevice::Save()';
    const {knownRacesIn} = await import('../helpers/known.js');
    // a block whose summary names memcpy is judged by its frames
    const viaFrames = `==================\nWARNING: ThreadSanitizer: data race (pid=7)\n  Write of size 8\n    #0 memcpy ../sanitizer_common_interceptors_memintrinsics.inc:1 (rfd+0x1)\n    #1 HM2::CCU2CoprocessorCommand::operator=(HM2::CCU2CoprocessorCommand const&) /openccu-base/src/rfd/hm2/CCU2CoprocessorCommand.h:38 (rfd+0x2)\nSUMMARY: ThreadSanitizer: data race ../sanitizer_common_interceptors_memintrinsics.inc:1 in memcpy\n==================\n`;
    assert.deepEqual(knownRacesIn(viaFrames), [
        process.env.HMRS_KNOWN_BROKEN?.includes('copro-request-races') ? 'copro-request-races' : null,
    ]);
    assert.deepEqual(knownRacesIn(`${ulc}\n${other}\n`), [
        process.env.HMRS_KNOWN_BROKEN?.includes('ulc-data-races') ? 'ulc-data-races' : null,
        null,
    ]);
    assert.ok(FINDINGS['ulc-data-races'].signatures.some((re) => re.test(ulc)));
    assert.ok(FINDINGS['lgw-wrapper-races'].signatures.some((re) => re.test(wrapper)));
    // HMRS_KNOWN_BROKEN of this process (test/helpers/known.js reads it once) names neither finding
    assert.equal(knownRaceOf(ulc), process.env.HMRS_KNOWN_BROKEN?.includes('ulc-data-races') ? 'ulc-data-races' : null);
    assert.equal(knownRaceOf(other), null);

    // a daemon with report files: a known one, a mixed one, an ASan one
    const {Daemon} = await import('../helpers/daemon.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmrs-reports-'));
    fs.writeFileSync(path.join(dir, 'tsan.rfd.1'), `WARNING: ThreadSanitizer: data race\n${ulc}\n`);
    fs.writeFileSync(path.join(dir, 'tsan.rfd.2'), `${ulc}\n${other}\n`);
    fs.writeFileSync(path.join(dir, 'asan.rfd.3'), 'SUMMARY: AddressSanitizer: heap-use-after-free in x\n');
    const d = new Daemon('rfd', '/bin/true', [], dir, 0);
    const all = d.allSanitizerReports().sort((a, b) => a.file.localeCompare(b.file));
    assert.deepEqual(
        all.map((r) => [r.file, r.known, r.findings]),
        [
            ['asan.rfd.3', false, []],
            ['tsan.rfd.1', Boolean(knownRaceOf(ulc)), knownRaceOf(ulc) ? ['ulc-data-races'] : []],
            ['tsan.rfd.2', false, knownRaceOf(ulc) ? ['ulc-data-races'] : []],
        ],
    );
    assert.equal(d.sanitizerReports().length + d.knownSanitizerReports().length, 3);
    fs.rmSync(dir, {recursive: true});
});
