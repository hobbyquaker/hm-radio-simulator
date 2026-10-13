import {test} from 'node:test';
import assert from 'node:assert/strict';

import {UPSTREAM_COMMITS, describeTest} from '../metadata.js';

test('a test named with a short commit of UPSTREAM_COMMITS is a regression test linking that commit', () => {
    const {kind, refs} = describeTest(
        'hs485d: a device without a serial is named ELV and its address in hex (c57eb49f)',
    );
    assert.equal(kind, 'regression');
    assert.deepEqual(refs, [
        {
            label: 'OpenCCU-Base c57eb49f',
            url: `https://github.com/OpenCCU/OpenCCU-Base/commit/${UPSTREAM_COMMITS.c57eb49f.commit}`,
            kind: 'commit',
        },
    ]);
    assert.equal(describeTest('a test about deadbeef').kind, 'behaviour');
    for (const [short, fix] of Object.entries(UPSTREAM_COMMITS)) {
        assert.ok(fix.commit.startsWith(short), short);
    }
});
