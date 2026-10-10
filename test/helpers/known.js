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
