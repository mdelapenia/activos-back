import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indicator, worldClimateSource } from '../server/world.mjs';

const DAY = 86400000;
const end = Date.parse('2026-11-10T21:00:00Z');
// Serie diaria de 400 días que sube de `from` a `to`.
const chart = (symbol, from, to) => ({ chart: { result: [{ meta: { symbol }, timestamp: Array.from({ length: 400 }, (_, i) => (end - (399 - i) * DAY) / 1000), indicators: { quote: [{ close: Array.from({ length: 400 }, (_, i) => from + (to - from) * i / 399) }] } }] } });
const symbolOf = url => decodeURIComponent(url.split('/chart/')[1].split('?')[0]);

test('resume cada indicador con último valor, 3 meses, extremos y mediana', () => {
    const points = Array.from({ length: 400 }, (_, i) => ({ time: end - (399 - i) * DAY, price: 100 + i }));
    assert.deepEqual(indicator(points), { last: 499, time: end, prev3m: 408, high52w: 499, low52w: 134, median: 300 });
});

test('devuelve el S&P 500 compacto y tolera indicadores caídos', async () => {
    let calls = 0;
    const fetcher = async url => {
        calls++;
        const symbol = symbolOf(url);
        if (symbol === 'CL=F') throw new Error('unavailable');
        if (symbol === '^IRX') return { ok: true, json: async () => chart('OTHER', 1, 2) };
        return { ok: true, json: async () => chart(symbol, symbol === '^VIX' ? 30 : 4000, symbol === '^VIX' ? 15 : 6000) };
    };
    const climate = worldClimateSource(fetcher);
    const data = await climate(end);
    assert.equal(data.sp500.length, 400);
    assert.deepEqual(data.sp500.at(-1), [Math.round(end / DAY), 6000]);
    assert.equal(data.indicators.vix.last, 15);
    assert.equal(data.indicators.oil, null);
    assert.equal(data.indicators.us3m, null);
    assert.equal(data.indicators.gold.high52w, 6000);
    // Segunda consulta dentro de la media hora: sale de la caché.
    await climate(end + 60000);
    assert.equal(calls, 6);
    await climate(end + 31 * 60000);
    assert.equal(calls, 12);
});

test('falla si no hay S&P 500', async () => {
    const fetcher = async url => symbolOf(url) === '^GSPC' ? { ok: false } : { ok: true, json: async () => chart(symbolOf(url), 1, 2) };
    await assert.rejects(worldClimateSource(fetcher)(end), /S&P 500/);
});
