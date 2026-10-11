import {test} from 'node:test';
import assert from 'node:assert/strict';

import {BIT_RATE, telegramAirtimeMs, exchangeMs, DutyCycleMeter, FRAME} from '../../lib/airtime.js';
import {Air} from '../../lib/air.js';
import {RadioModule} from '../../lib/module.js';
import {BIDCOS_STATUS} from '../../lib/commands.js';
import {encodeTelegram, decodeTelegram, FT} from '../../lib/telegram.js';

test('airtime: the CC1101 setup gives 9992.6 baud, 0.8 ms per byte; a switch command, an ACK, a burst', () => {
    assert.ok(Math.abs(BIT_RATE - 9992.6) < 0.1, String(BIT_RATE));
    assert.ok(Math.abs(telegramAirtimeMs(14) - 20.01) < 0.05, String(telegramAirtimeMs(14)));
    assert.ok(Math.abs(telegramAirtimeMs(10) - 16.81) < 0.05);
    assert.ok(Math.abs(telegramAirtimeMs(14, {burst: true}) - telegramAirtimeMs(14) - FRAME.burstMs) < 1e-9);
    const exchange = exchangeMs(14, 10);
    assert.ok(Math.abs(exchange - (20 + 20.01 + 16.81)) < 0.1, String(exchange));
    assert.equal(exchangeMs(14, 0), FRAME.gapMs + telegramAirtimeMs(14));
});

test('the duty-cycle meter: 1 % of a sliding window, entries age out', () => {
    let now = 0;
    const meter = new DutyCycleMeter({windowMs: 10000, now: () => now});
    assert.equal(meter.budgetMs, 100);
    meter.add(50);
    assert.equal(meter.percent(), 50);
    now = 5000;
    meter.add(50);
    assert.equal(meter.percent(), 100);
    now = 10001;
    assert.equal(meter.percent(), 50, 'the first entry left the window');
    assert.equal(meter.totalMs, 100);
});

test('the air with airtime: computed delays, the duty cycle reported by the module, a refusal at the limit', async () => {
    const module = new RadioModule();
    const events = [];
    module.writeFrame = (payload) => events.push(payload);
    const air = new Air({module, airtime: {windowMs: 2000, enforce: 'always'}}); // budget 20 ms: one 20 ms telegram spends it
    const raw = encodeTelegram({
        counter: 1,
        ctrl: 0x00,
        type: FT.SWITCH,
        src: 0x111111,
        dst: 0x222222,
        payload: [1, 2, 3, 4, 5],
    });
    const request = {telegram: decodeTelegram(raw), raw, burst: 0, waitMs: 0};
    const at = Date.now();
    const first = await air.send(request);
    assert.equal(first.status, BIDCOS_STATUS.TELEGRAM_SENT);
    assert.ok(Date.now() - at >= 25, 'the gap and the airtime were waited for');
    assert.ok(air.meter.percent() >= 90, String(air.meter.percent()));
    assert.ok(module.dutyCycle >= 90, 'the module reported its duty cycle');
    const second = await air.send(request);
    assert.equal(second.status, BIDCOS_STATUS.SEND_FAILED_DUTYCYCLE);
    assert.deepEqual(
        air.sends.map((s) => s.status),
        ['sent', 'duty-cycle'],
    );
});

test('the air with airtime: no refusal while the module duty-cycle check is off (as rfd sets it)', async () => {
    const module = new RadioModule();
    module.writeFrame = () => {};
    module.dutyCycleCheck = false;
    const air = new Air({module, airtime: {windowMs: 2000}});
    const raw = encodeTelegram({
        counter: 1,
        ctrl: 0x00,
        type: FT.SWITCH,
        src: 0x111111,
        dst: 0x222222,
        payload: [1, 2, 3, 4, 5],
    });
    const request = {telegram: decodeTelegram(raw), raw, burst: 0, waitMs: 0};
    await air.send(request);
    assert.equal((await air.send(request)).status, BIDCOS_STATUS.TELEGRAM_SENT);
    assert.ok(air.meter.percent() > 150, 'the budget is overspent');
});

test('the meter against a real module: 200 switch commands cost ~11.5 % of the 1 % budget (measured 2026-10-11)', () => {
    // measured on an RPI-RF-MOD: 200 acknowledged switch commands raised its duty cycle from 14.0 to 25.5 %, reported in
    // half-percent steps (so 11.5 +- 0.5); the devices' ACKs do not count against the central's budget
    let now = 0;
    const meter = new DutyCycleMeter({now: () => now});
    for (let i = 0; i < 200; i++) {
        meter.add(telegramAirtimeMs(14));
        now += 1000;
    }
    const percent = meter.percent();
    assert.ok(percent >= 10.5 && percent <= 12.5, `200 commands = ${percent.toFixed(2)} % (measured 11.5 +- 0.5)`);
});
