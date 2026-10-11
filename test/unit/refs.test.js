import {test} from 'node:test';
import assert from 'node:assert/strict';

import {compareRefs, newestReleaseTags, knownBroken} from '../../scripts/refs.mjs';
import {buildDifferential} from '../../scripts/differential.mjs';

test('the refs: release tags by version, oldest first, main last; the two newest tags picked', () => {
    assert.deepEqual(['main', '3.89.11', 'feature-x', '3.89.9', '3.100.0'].sort(compareRefs), [
        '3.89.9',
        '3.89.11',
        '3.100.0',
        'feature-x',
        'main',
    ]);
    assert.deepEqual(newestReleaseTags(['3.89.9', 'v-test', '3.89.11', '3.89.10-rc1', '3.88.4', '']), [
        '3.89.9',
        '3.89.11',
    ]);
    assert.deepEqual(newestReleaseTags(['3.89.11']), ['3.89.11']);
});

test('the known-broken list is derived: a fix whose commit the ref lacks, a finding until its fix is in the ref', () => {
    const fixes = {140: {commit: 'c140'}, 27: {commit: 'c27'}, 9: {commit: 'c9'}};
    const findings = {'double-join': {}, 'fixed-later': {fixedBy: 'cf'}};
    const has = (set) => (commit) => set.includes(commit);
    assert.deepEqual(knownBroken(has(['c9']), fixes, findings), ['27', '140', 'double-join', 'fixed-later']);
    assert.deepEqual(knownBroken(has(['c9', 'c27', 'c140', 'cf']), fixes, findings), ['double-join']);
});

test('the differential compares neighbours: the older tag with the newer one, the newer one with main', () => {
    const job = (ref, answer) => ({ref, variant: 'release', baseCommit: `sha-${ref}`, sweep: {s: {m: answer}}});
    const sections = buildDifferential([job('main', 'c'), job('3.89.11', 'b'), job('3.89.9', 'a')]);
    assert.deepEqual(
        sections.map((s) => [s.title, s.diff.changed]),
        [
            ['3.89.9 → 3.89.11', 1],
            ['3.89.11 → main', 1],
        ],
    );
});
