/**
 * The daemons under test come from a configurable OpenCCU-Base ref. A regression test for a bug that the ref does not
 * have the fix for yet is run as a `todo`, so it shows what happens without failing the run: HMRS_KNOWN_BROKEN lists
 * the OpenCCU-Base issue numbers that are known to be unfixed in the image's ref (the Dockerfile sets it per ref).
 */

const broken = new Set(
    (process.env.HMRS_KNOWN_BROKEN || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
);

import {FINDINGS} from '../metadata.js';

/**
 * @param {...(number|string)} issues OpenCCU-Base pull request numbers or finding names; the test is a todo when any
 *   of them is listed as known broken
 * @returns {{todo?: string}} options for node:test
 */
export function regression(...issues) {
    const listed = issues.filter((issue) => broken.has(String(issue)));
    if (listed.length > 0) {
        const what = listed
            .map((issue) => (/^\d+$/.test(String(issue)) ? `OpenCCU-Base #${issue}` : `the ${issue} finding`))
            .join(' and ');
        return {todo: `${what} is not fixed in this BASE_REF (HMRS_KNOWN_BROKEN)`};
    }
    return {};
}

export function isKnownBroken(issue) {
    return broken.has(String(issue));
}

/**
 * The finding a sanitizer SUMMARY line (or a stack frame line) belongs to, when that finding's fix is known to be
 * missing on this ref (HMRS_KNOWN_BROKEN); null for a line no known finding explains.
 * @param {string} line e.g. "SUMMARY: ThreadSanitizer: data race /x/LGWPortWrapper.cpp:108 in HM2::LGWPortWrapper::ReadData()"
 */
export function knownRaceOf(line) {
    for (const [name, finding] of Object.entries(FINDINGS)) {
        if (finding.signatures && broken.has(name) && finding.signatures.some((re) => re.test(line))) {
            return name;
        }
    }
    return null;
}

/**
 * The findings that explain a ThreadSanitizer report file: one entry per report block (a block ends in its SUMMARY
 * line) - the finding its summary names or, when the summary names a libc interceptor (memcpy, strlen ...), the
 * finding one of the block's own frames names; null for a block no known finding explains.
 * @param {string} text the report file
 * @returns {Array<string|null>}
 */
export function knownRacesIn(text) {
    const result = [];
    let frames = [];
    for (const line of text.split('\n')) {
        if (/^\s+#\d+ /.test(line)) {
            frames.push(line);
        } else if (line.startsWith('SUMMARY: ')) {
            let found = knownRaceOf(line);
            if (!found && /\bin (?:__interceptor_)?(?:mem\w+|str\w+|wcs\w+)$/.test(line.trim())) {
                found = frames.map((f) => knownRaceOf(f)).find(Boolean) || null;
            }
            result.push(found);
            frames = [];
        } else if (/^=+$/.test(line.trim())) {
            frames = [];
        }
    }
    return result;
}

/** Whether the daemons under test are the ThreadSanitizer variant (HMRS_DAEMONS ends with tsan). */
export const underTsan = /tsan$/.test(process.env.HMRS_DAEMONS || '');

/**
 * Like regression(), but only under ThreadSanitizer: for the data races the tsan variant reports on a ref that lacks
 * their fix (a finding or a fix number), while the release and ASan variants of the same test pass. On the other
 * variants the test runs for real.
 * @param {...(number|string)} issues
 */
export function raceRegression(...issues) {
    return underTsan ? regression(...issues) : {};
}
