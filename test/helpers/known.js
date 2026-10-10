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
 * @param {number|string} issue the OpenCCU-Base pull request or issue number
 * @returns {{todo?: string}} options for node:test
 */
export function regression(issue) {
    if (broken.has(String(issue))) {
        const what = /^\d+$/.test(String(issue)) ? `OpenCCU-Base #${issue}` : `the ${issue} finding`;
        return {todo: `${what} is not fixed in this BASE_REF (HMRS_KNOWN_BROKEN)`};
    }
    return {};
}

export function isKnownBroken(issue) {
    return broken.has(String(issue));
}
