import {test} from 'node:test';
import assert from 'node:assert/strict';

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
