/**
 * Load on rfd: fast setValue/putParamset bursts, radio events meanwhile, a sustained run against the duty cycle and a
 * deliberate overload - on the air model with computed airtime (lib/airtime.js: 9992.6 baud, 0.8 ms per byte, 10 ms
 * gaps, the 1 % duty cycle; computed, not measured).
 *
 * What rfd does with a flood, from its source (3.89.11): a setValue is sent synchronously - the RPC handler runs on
 * the main loop and waits in CCU2CommController::sendBidcosTelegram for the module's status (defaultResponseTimeout
 * 4000 ms), so commands are serialised by rfd itself, one exchange at a time, and the call returns after the ACK;
 * there is no command queue that could collapse two values for one channel. Received telegrams are queued by the
 * interface's reader thread (BidcosInterfaceConcentrator rx_frame_queue, RX_QUEUE_MAX_SIZE 1024, the oldest dropped
 * beyond it) and processed by the main loop between RPC requests.
 *
 * The levels (task "load tests", proposed from the airtime): the theoretical maximum is one exchange per
 * (10 ms + command + 10 ms + ACK) - about 16 per second for a switch command; a burst offers 50 % of that, the
 * overload 200 %; the sustained run spends 50 % of the duty-cycle budget in a window scaled down to 30 s (the
 * budget is always 1 % of the window: 300 ms of the central's airtime), the overload a 10 s window it exceeds.
 *
 * Timing assumptions: the module's status arrives within rfd's 4000 ms; margins of seconds for RPC latency.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {startRfd, withDaemon, skipWithoutDaemons} from '../helpers/daemon.js';
import {regression, isKnownBroken} from '../helpers/known.js';
import {startReceiver, BinRpcClient, XmlRpcClient} from '../helpers/rpc.js';
import {pairDevice, description, eventValues} from '../helpers/switch.js';
import {Air} from '../../lib/air.js';
import {BidcosDevice, RemoteBehaviour} from '../../lib/device.js';
import {exchangeMs, telegramAirtimeMs, DutyCycleMeter} from '../../lib/airtime.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SWITCHES = 6;

/** Writes the load numbers next to the results, for the report's table (not a sweep record: they vary by run). */
function writeLoad(name, data) {
    const work = process.env.HMRS_WORKDIR;
    if (!work) {
        return;
    }
    const file = path.join(path.dirname(work), 'load.json');
    let all = {};
    try {
        all = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        all = {};
    }
    all[name] = data;
    fs.writeFileSync(file, JSON.stringify(all, null, 1) + '\n');
}

function rssKb(pid) {
    const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) : 0;
}

function stats(values) {
    const v = [...values].sort((a, b) => a - b);
    const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    return {n: v.length, median: q(0.5), p95: q(0.95), max: v[v.length - 1]};
}

/** rfd with the metered air, six switches and a remote, all paired, a receiver registered. */
async function setup(t, {windowMs = 3600 * 1000, reportCap = 100} = {}) {
    const rfd = await startRfd();
    // pairing seven devices takes more airtime than a scaled window allows: the scaled meter starts after it
    const air = new Air({module: rfd.module, airtime: {reportCap}});
    rfd.air = air;
    const receiver = await startReceiver();
    await rfd.call('init', [receiver.url, 'load']);
    const switches = [];
    for (let i = 0; i < SWITCHES; i++) {
        const sw = air.add(
            new BidcosDevice({
                address: 0x6a0000 + i,
                serial: `SIMLOAD${String(i).padStart(3, '0')}`,
                description: description('rf_s.xml'),
                typeId: 'HM-LC-Sw1-Pl',
            }),
        );
        await pairDevice(rfd, receiver, air, sw, {timeout: 60000});
        switches.push(sw);
    }
    const remote = air.add(
        new BidcosDevice({
            address: 0x6b0001,
            serial: 'SIMLOADRC1',
            description: description('rf_rc.xml'),
            typeId: 'HM-RC-4',
            behaviour: new RemoteBehaviour(),
            channelCount: 4,
            peeringChannel: 0,
            aes: true,
        }),
    );
    await pairDevice(rfd, receiver, air, remote, {timeout: 60000});
    // the computed exchange of one switch command, from the frames the air saw
    const before = air.trace.length;
    await rfd.call('setValue', [`${switches[0].serial}:1`, 'STATE', false], {timeout: 10000});
    const tx = air.trace.slice(before).find((e) => e.dir === 'tx' && e.name.startsWith('LEVEL_SET'));
    const rx = air.trace.slice(before).find((e) => e.dir === 'rx');
    const commandBytes = tx ? tx.hex.length / 2 : 14;
    const answerBytes = rx ? rx.hex.length / 2 : 14;
    const exchange = exchangeMs(commandBytes, answerBytes);
    air.meter = new DutyCycleMeter({windowMs});
    air.reportedDuty = 0;
    rfd.module.sendDutyCycleEvent(0);
    await sleep(200);
    const airMax = 1000 / exchange;
    t.diagnostic(
        `switch command ${commandBytes} bytes (${telegramAirtimeMs(commandBytes).toFixed(1)} ms), answer ${answerBytes} bytes; one exchange ${exchange.toFixed(1)} ms -> ${airMax.toFixed(1)} exchanges/s at most; duty-cycle window ${windowMs / 1000} s (budget ${(windowMs / 100).toFixed(0)} ms)`,
    );
    return {rfd, air, receiver, switches, remote, commandBytes, answerBytes, exchange, airMax};
}

/** Fires `count` setValue calls at `ratePerSecond` over `clients`, without waiting for the answers in between. */
async function burst(clients, calls, ratePerSecond) {
    const results = [];
    const started = Date.now();
    const pending = calls.map(
        (call, i) =>
            new Promise((resolve) => {
                setTimeout(
                    async () => {
                        const at = Date.now();
                        const client = clients[i % clients.length];
                        try {
                            const r = await client.call('setValue', call, {timeout: 60000});
                            // binrpc hands a fault back as a result struct
                            if (r && typeof r === 'object' && 'faultCode' in r) {
                                throw r;
                            }
                            results.push({i, ok: true, latency: Date.now() - at, done: Date.now()});
                        } catch (error) {
                            results.push({
                                i,
                                ok: false,
                                latency: Date.now() - at,
                                done: Date.now(),
                                error: error.faultString || error.message,
                            });
                        }
                        resolve();
                    },
                    (i * 1000) / ratePerSecond,
                );
            }),
    );
    await Promise.all(pending);
    return {results, durationMs: Math.max(...results.map((r) => r.done)) - started};
}

test(
    'rfd load: a burst at 50 % of the air maximum to six switches and one channel, a putParamset in it, remote presses meanwhile - every call answered, every event delivered, the last value wins',
    {...skipWithoutDaemons, timeout: 600000},
    async (t) => {
        const {rfd, air, receiver, switches, remote, airMax} = await setup(t);
        const clients = Array.from({length: 6}, () => new BinRpcClient(rfd.port));
        await withDaemon(rfd, async () => {
            const rate = airMax * 0.5;
            const count = Math.round(rate * 6); // six seconds of it
            const calls = Array.from({length: count}, (_, i) => [
                `${switches[i % SWITCHES].serial}:1`,
                'STATE',
                Math.floor(i / SWITCHES) % 2 === 0,
            ]);
            const expected = new Map();
            calls.forEach(([address, , value]) => expected.set(address, value));
            const fromTrace = air.trace.length;
            const fromEvents = receiver.received.length;
            // a MASTER write in the middle of it, and the remote pressed every 300 ms throughout
            const master = new Promise((resolve) =>
                setTimeout(async () => {
                    const at = Date.now();
                    const r = await rfd
                        .call('putParamset', [switches[2].serial, 'MASTER', {LOCAL_RESET_DISABLE: true}], {
                            timeout: 60000,
                        })
                        .then(
                            () => 'ok',
                            (e) => `error ${e.faultString || e.message}`,
                        );
                    resolve({r, ms: Date.now() - at});
                }, 2000),
            );
            const presses = [];
            const presser = setInterval(() => {
                presses.push(Date.now());
                air.press(remote, 1 + (presses.length % 4));
            }, 300);
            const rss0 = rssKb(rfd.pid);
            const {results, durationMs} = await burst(clients, calls, rate);
            clearInterval(presser);
            const putResult = await master;
            await sleep(3000);
            const lat = stats(results.map((r) => r.latency));
            const failed = results.filter((r) => !r.ok);
            const levelSets = air.trace
                .slice(fromTrace)
                .filter((e) => e.dir === 'tx' && e.name.startsWith('LEVEL_SET')).length;
            const pressEvents = receiver.received
                .slice(fromEvents)
                .filter((r) => r.method === 'event' && r.params[2] === 'PRESS_SHORT').length;
            const states = switches.map((sw) => sw.behaviour.channel(1).STATE !== 0);
            const wanted = switches.map((sw) => expected.get(`${sw.serial}:1`));
            const numbers = {
                offeredPerSecond: Number(rate.toFixed(1)),
                calls: count,
                achievedPerSecond: Number(((count * 1000) / durationMs).toFixed(1)),
                airMaxPerSecond: Number(airMax.toFixed(1)),
                latencyMs: lat,
                failed: failed.length,
                levelSetFrames: levelSets,
                presses: presses.length,
                pressEvents,
                putParamset: putResult,
                rssKb: [rss0, rssKb(rfd.pid)],
            };
            writeLoad('burst', numbers);
            t.diagnostic(JSON.stringify(numbers));
            assert.equal(failed.length, 0, `failed calls: ${failed.map((f) => f.error).join('; ')}`);
            assert.equal(levelSets, count, 'every call reached the air once: rfd does not collapse or drop commands');
            assert.deepEqual(states, wanted, 'each switch ends on the last value sent to it');
            assert.equal(putResult.r, 'ok', 'the MASTER write completes under load');
            // rfd discards unread serial input before every command it writes (tcflush TCIFLUSH): an event that is in the
            // kernel buffer at that instant is lost - the flush-drops-events finding, more likely the busier rfd is
            await t.test(
                'every press reached the receiver (the flush-drops-events finding)',
                regression('flush-drops-events'),
                () => assert.equal(pressEvents, presses.length, `${pressEvents} of ${presses.length} presses arrived`),
            );
            assert.deepEqual(rfd.sanitizerReports(), []);
        }).finally(async () => {
            clients.forEach((c) => c.client.close());
            await receiver.stop();
        });
    },
);

test(
    'rfd load: twenty values to one channel at once over one connection and over XML-RPC - all sent in order, the last one wins',
    {...skipWithoutDaemons, timeout: 600000},
    async (t) => {
        const {rfd, air, receiver, switches} = await setup(t);
        const xml = new XmlRpcClient(rfd.port);
        await withDaemon(rfd, async () => {
            const sw = switches[0];
            const address = `${sw.serial}:1`;
            for (const [name, client] of [
                ['binrpc', rfd.rpc],
                ['xmlrpc', xml],
            ]) {
                const from = air.trace.length;
                const values = Array.from({length: 20}, (_, i) => i % 2 === 0);
                values.push(true);
                const at = Date.now();
                const answers = await Promise.all(
                    values.map((v) =>
                        client.call('setValue', [address, 'STATE', v], {timeout: 60000}).then(
                            (r) => (r && typeof r === 'object' && 'faultCode' in r ? `fault ${r.faultString}` : 'ok'),
                            (e) => e.message,
                        ),
                    ),
                );
                const ms = Date.now() - at;
                const frames = air.trace
                    .slice(from)
                    .filter((e) => e.dir === 'tx' && e.name.startsWith('LEVEL_SET')).length;
                t.diagnostic(
                    `${name}: ${values.length} calls in ${ms} ms, ${frames} LEVEL_SET frames, state ${sw.behaviour.channel(1).STATE !== 0}`,
                );
                assert.ok(
                    answers.every((a) => a === 'ok'),
                    answers.join(' '),
                );
                assert.equal(frames, values.length, 'no collapsing');
                assert.equal(sw.behaviour.channel(1).STATE !== 0, true, 'the last value wins');
                writeLoad(`same-channel-${name}`, {calls: values.length, ms, frames});
            }
        }).finally(() => receiver.stop());
    },
);

test(
    'rfd load: a sustained run at 50 % of the duty-cycle budget (window scaled to 30 s) - rfd reports the duty cycle the module counts, memory stays flat',
    {...skipWithoutDaemons, timeout: 600000},
    async (t) => {
        const windowMs = 30000;
        const {rfd, air, receiver, switches} = await setup(t, {windowMs});
        await withDaemon(rfd, async () => {
            const perCommand = telegramAirtimeMs(14);
            const interval = (perCommand / (air.meter.budgetMs * 0.5)) * windowMs;
            const rss0 = rssKb(rfd.pid);
            const until = Date.now() + 2 * windowMs;
            let n = 0;
            let failures = 0;
            while (Date.now() < until) {
                await rfd
                    .call('setValue', [`${switches[n % SWITCHES].serial}:1`, 'STATE', n % 2 === 0], {timeout: 10000})
                    .then(
                        (r) => {
                            if (r && typeof r === 'object' && 'faultCode' in r) {
                                failures++;
                            }
                        },
                        () => failures++,
                    );
                n++;
                await sleep(interval);
            }
            await sleep(1500);
            const meter = air.meter.percent();
            const iface = (await rfd.call('listBidcosInterfaces'))[0];
            const numbers = {
                windowMs,
                commands: n,
                failures,
                meterPercent: Number(meter.toFixed(1)),
                moduleReported: Number(rfd.module.dutyCycle.toFixed(1)),
                rfdDutyCycle: iface.DUTY_CYCLE,
                rssKb: [rss0, rssKb(rfd.pid)],
            };
            writeLoad('sustained', numbers);
            t.diagnostic(JSON.stringify(numbers));
            assert.equal(failures, 0);
            assert.ok(meter > 30 && meter < 75, `the run used ${meter.toFixed(0)} % of the budget (aimed at 50 %)`);
            assert.ok(
                Math.abs(iface.DUTY_CYCLE - rfd.module.dutyCycle) <= 2,
                `rfd says ${iface.DUTY_CYCLE} %, the module reported ${rfd.module.dutyCycle.toFixed(1)} %`,
            );
            assert.ok(numbers.rssKb[1] < numbers.rssKb[0] * 1.2 + 2048, `RSS ${numbers.rssKb.join(' -> ')} kB`);
        }).finally(() => receiver.stop());
    },
);

test(
    'rfd load: an overload at 200 % of the air maximum with the module refusing past the duty-cycle limit (window 10 s) - RPC stays responsive, events still arrive, rfd recovers',
    {...skipWithoutDaemons, timeout: 600000},
    async (t) => {
        const windowMs = 10000;
        // a reported 100 % trips the dutycycle-upper-bound finding (its own test below): 99 % while it is unfixed
        const reportCap = isKnownBroken('dutycycle-upper-bound') ? 99 : 100;
        const {rfd, air, receiver, switches, remote, airMax} = await setup(t, {windowMs, reportCap});
        const clients = Array.from({length: 8}, () => new BinRpcClient(rfd.port));
        const probe = new BinRpcClient(rfd.port);
        await withDaemon(rfd, async () => {
            const rate = airMax * 2;
            const count = Math.round(rate * 5);
            const calls = Array.from({length: count}, (_, i) => [
                `${switches[i % SWITCHES].serial}:1`,
                'STATE',
                i % 2 === 0,
            ]);
            const rss0 = rssKb(rfd.pid);
            const probeLatencies = [];
            let probing = true;
            const prober = (async () => {
                while (probing) {
                    const at = Date.now();
                    await probe.call('listDevices', [], {timeout: 30000}).catch(() => {});
                    probeLatencies.push(Date.now() - at);
                    await sleep(250);
                }
            })();
            const fromEvents = receiver.received.length;
            const fromTrace = air.trace.length;
            const pressesAt = [];
            const presser = setInterval(() => {
                pressesAt.push(Date.now());
                air.press(remote, 1);
            }, 500);
            const {results, durationMs} = await burst(clients, calls, rate);
            clearInterval(presser);
            probing = false;
            await prober;
            const failed = results.filter((r) => !r.ok);
            const refused = air.sends.filter((s) => s.status === 'duty-cycle').length;
            const onAir = air.trace
                .slice(fromTrace)
                .filter((e) => e.dir === 'tx' && e.name.startsWith('LEVEL_SET')).length;
            const unreach = receiver.received
                .slice(fromEvents)
                .filter((r) => r.method === 'event' && r.params[2] === 'UNREACH' && r.params[3] === true).length;
            await sleep(2000);
            const pressEvents = eventValues(receiver, 'SIMLOADRC1:1', 'PRESS_SHORT', fromEvents).length;
            // recovery: the window passes, a command goes through again
            await sleep(windowMs);
            const recovered = await rfd
                .call('setValue', [`${switches[0].serial}:1`, 'STATE', true], {timeout: 10000})
                .then(
                    (r) => !(r && typeof r === 'object' && 'faultCode' in r),
                    () => false,
                );
            const numbers = {
                offeredPerSecond: Number(rate.toFixed(1)),
                calls: count,
                durationMs,
                answeredOk: results.length - failed.length,
                faults: failed.length,
                refusedByModule: refused,
                levelSetOnAir: onAir,
                unreachEvents: unreach,
                faultTexts: [...new Set(failed.map((f) => f.error))].slice(0, 3),
                latencyMs: stats(results.map((r) => r.latency)),
                probeLatencyMs: stats(probeLatencies),
                presses: pressesAt.length,
                pressEvents,
                recovered,
                rssKb: [rss0, rssKb(rfd.pid)],
            };
            writeLoad('overload', numbers);
            t.diagnostic(JSON.stringify(numbers));
            assert.ok(rfd.alive, `rfd died: ${JSON.stringify(rfd.exit)}`);
            assert.ok(refused > 0, 'the duty-cycle limit was reached');
            assert.ok(
                numbers.probeLatencyMs.max < 10000,
                `RPC answered within 10 s throughout (max ${numbers.probeLatencyMs.max} ms)`,
            );
            assert.ok(pressEvents > 0, 'events still arrive under overload');
            await t.test(
                'every press reached the receiver (the flush-drops-events finding)',
                regression('flush-drops-events'),
                () =>
                    assert.equal(
                        pressEvents,
                        pressesAt.length,
                        `${pressEvents} of ${pressesAt.length} presses arrived`,
                    ),
            );
            assert.ok(recovered, 'commands go through again once the window has passed');
            assert.ok(numbers.rssKb[1] < numbers.rssKb[0] * 1.2 + 2048, `RSS ${numbers.rssKb.join(' -> ')} kB`);
            assert.deepEqual(rfd.sanitizerReports(), []);
        }).finally(async () => {
            clients.forEach((c) => c.client.close());
            probe.client.close();
            await receiver.stop();
        });
    },
);

test(
    'rfd takes a reported duty cycle of 100 % without reading past its threshold map (the dutycycle-upper-bound finding)',
    {...skipWithoutDaemons, ...regression('dutycycle-upper-bound'), timeout: 120000},
    async (t) => {
        // BidcosInterface::GetDutyCycleUpperBound: `if (duty_cycle_threshold <= SIZE) return MAP[threshold + 1]` -
        // at 100 % the threshold reaches the last entry and the next one is read past the array
        const rfd = await startRfd();
        await withDaemon(rfd, async () => {
            for (const percent of [50, 90, 99, 100]) {
                rfd.module.sendDutyCycleEvent(percent);
                await sleep(300);
            }
            const iface = (await rfd.call('listBidcosInterfaces'))[0];
            t.diagnostic(`DUTY_CYCLE after 100 %: ${iface.DUTY_CYCLE}`);
            assert.ok(rfd.alive, `rfd died: ${JSON.stringify(rfd.exit)}`);
            assert.equal(iface.DUTY_CYCLE, 100);
            assert.deepEqual(rfd.sanitizerReports(), []);
        });
    },
);
