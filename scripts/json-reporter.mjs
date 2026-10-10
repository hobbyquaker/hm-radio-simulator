/**
 * A node:test reporter that writes the run as JSON: one record per test (and subtest) with its file, status
 * (pass, fail, todo, skip), duration, error message and the diagnostics the test printed. The report script
 * (scripts/report.mjs) reads these files; the JUnit output stays for the artifacts.
 *
 *   node --test --test-reporter=./scripts/json-reporter.mjs --test-reporter-destination=results/tests.json ...
 */

export default async function* jsonReporter(source) {
    const tests = [];
    const pending = [];
    for await (const event of source) {
        const data = event.data;
        switch (event.type) {
            case 'test:pass':
            case 'test:fail': {
                const status = data.skip ? 'skip' : data.todo ? 'todo' : event.type === 'test:pass' ? 'pass' : 'fail';
                const error = data.details && data.details.error;
                const record = {
                    name: data.name,
                    file: data.file ? data.file.replace(/^.*\/test\//, 'test/') : null,
                    nesting: data.nesting,
                    status,
                    todo: typeof data.todo === 'string' ? data.todo : data.todo ? true : undefined,
                    skip: typeof data.skip === 'string' ? data.skip : data.skip ? true : undefined,
                    durationMs: data.details ? Math.round(data.details.duration_ms * 1000) / 1000 : null,
                    error: error
                        ? firstLine(error.cause ? error.cause.message || error.message : error.message)
                        : undefined,
                    diagnostics: [],
                };
                // diagnostics of this test come after it (node emits them when the test finished)
                tests.push(record);
                pending.push(record);
                break;
            }
            case 'test:diagnostic': {
                if (
                    data.nesting === 0 &&
                    /^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(data.message)
                ) {
                    break; // the run summary
                }
                const owner = pending.findLast((t) => t.nesting === data.nesting && t.file === fileOf(data));
                if (owner) {
                    owner.diagnostics.push(data.message);
                }
                break;
            }
            default:
                break;
        }
    }
    const counts = {pass: 0, fail: 0, todo: 0, skip: 0};
    for (const t of tests) {
        counts[t.status]++;
    }
    yield JSON.stringify({generatedAt: new Date().toISOString(), counts, tests}, null, 1) + '\n';
}

function fileOf(data) {
    return data.file ? data.file.replace(/^.*\/test\//, 'test/') : null;
}

function firstLine(text) {
    return String(text || '')
        .split('\n')[0]
        .slice(0, 300);
}
