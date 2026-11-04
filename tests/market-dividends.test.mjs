import test from 'node:test';
import assert from 'node:assert/strict';
import { marketDividends } from '../server/dividends.mjs';

test('calendario incluye pagos próximos de cualquier ticker y recorre páginas', async () => {
    let calls = 0;
    const fetcher = async url => {
        calls++;
        assert.equal(url.searchParams.get('apiKey'), 'key');
        return { ok: true, json: async () => calls === 1 ? { results: [{ ticker: 'ZZZ', pay_date: '2026-11-09', ex_dividend_date: '2026-10-30', cash_amount: 0.5, currency: 'USD' }, { ticker: 'OLD', pay_date: '2026-10-01', cash_amount: 1 }], next_url: 'https://api.massive.com/stocks/v1/dividends?cursor=abc' } : { results: [{ ticker: 'AAA', pay_date: '2026-11-05', cash_amount: 1.25, currency: 'USD' }] } };
    };
    const result = await marketDividends('key', fetcher, Date.parse('2026-11-03T12:00:00Z'));
    assert.deepEqual(result.items.map(item => item.ticker), ['AAA', 'ZZZ']);
    assert.equal(result.items[0].exDate, null);
    assert.equal(result.truncated, false);
    assert.equal(calls, 2);
});

test('calendario sin clave no consulta el proveedor', async () => {
    const result = await marketDividends('', () => { throw new Error('unexpected'); });
    assert.equal(result.configured, false);
});
