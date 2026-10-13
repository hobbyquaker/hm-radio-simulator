// A test file that passes and leaks a server: run by test/unit/hang-guard.test.js through `node --test`, it must end
// with the guard's exit code 1 instead of hanging.
import {test} from 'node:test';
import net from 'node:net';

import {track} from '../../helpers/hang-guard.js';

const server = net.createServer().listen(0, '127.0.0.1');
// a "daemon" a timed-out test left behind: stopped and named by the guard
const stopped = [];
track({
    name: 'leaked-daemon',
    pid: 4711,
    get alive() {
        return stopped.length === 0;
    },
    async stop() {
        stopped.push(Date.now());
    },
});

test('passes, leaks the server', () => {
    console.log(`listening on ${server.address().port}`);
});
