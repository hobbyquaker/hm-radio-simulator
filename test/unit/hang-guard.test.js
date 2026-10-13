import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'hang-guard', 'leak.mjs');

test('the hang guard: a file whose process does not end after its last test fails instead of hanging', () => {
    // the fixture runs as a plain node process (node:test refuses a nested `node --test`); its hooks run the same
    const env = {...process.env, HMRS_HANG_GRACE_MS: '1000'};
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, [FIXTURE], {
        env,
        encoding: 'utf8',
        timeout: 30000,
    });
    assert.equal(run.signal, null, 'the fixture ended on its own (not killed by the timeout)');
    assert.equal(run.status, 1, `exit status ${run.status}\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /hang guard: leaked-daemon \(pid 4711\) is still running after the last test/);
    assert.match(
        run.stderr,
        /hang guard: the test process is still alive 1000 ms after its last test; open handles: .*TCPServerWrap/,
    );
    assert.match(run.stdout, /passes, leaks the server/);
});
