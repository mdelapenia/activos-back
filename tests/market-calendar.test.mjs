import test from 'node:test';
import assert from 'node:assert/strict';
import { earningsCalendar } from '../server/market-calendar.mjs';

test('normaliza balances y preserva la fecha solicitada', async () => {
    const data = await earningsCalendar('2026-11-05', async url => {
        assert.equal(url.searchParams.get('date'), '2026-11-05');
        return { ok: true, json: async () => ({ data: { rows: [{ symbol: 'AAPL', name: 'Apple', time: 'time-after-hours' }, { symbol: null }] } }) };
    });
    assert.deepEqual(data, { date: '2026-11-05', items: [{ ticker: 'AAPL', name: 'Apple', time: 'Después del cierre' }] });
});

test('rechaza fechas inválidas y errores de proveedor', async () => {
    await assert.rejects(() => earningsCalendar('2026-02-30'));
    await assert.rejects(() => earningsCalendar('2026-11-05', async () => ({ ok: false })));
});
