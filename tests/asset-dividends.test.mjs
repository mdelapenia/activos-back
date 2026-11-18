import test from 'node:test';
import assert from 'node:assert/strict';
import { assetDividends } from '../server/dividends.mjs';

const now = Date.parse('2026-11-04T12:00:00Z');
test('consulta pagos de una acción aunque no esté en cartera y distingue estimados', async () => {
    const fetcher = async url => {
        assert.equal(url.searchParams.get('ticker'), 'AAPL');
        return { ok: true, json: async () => ({ results: [
            { pay_date: '2026-12-10', ex_dividend_date: '2026-11-10', cash_amount: 0.25, currency: 'USD' },
            { pay_date: '2026-02-10', ex_dividend_date: '2026-01-10', cash_amount: 0.20, currency: 'USD' },
        ] }) };
    };
    const result = await assetDividends('stock', 'AAPL', 'secret', fetcher, now);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.events, [
        { payDate: '2026-12-10', exDate: '2026-11-10', amountPerShare: 0.25, estimated: false },
        { payDate: '2027-02-10', exDate: '2027-01-10', amountPerShare: 0.20, estimated: true, sourcePayDate: '2026-02-10' },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /secret|eligible|estimatedGross/);
});
test('un CEDEAR consulta el ticker subyacente y devuelve el importe por acción', async () => {
    const fetcher = async url => String(url).includes('cedears.json')
        ? { ok: true, json: async () => ({ items: [{ Cedears: 'LOCAL', Ratio: '10', TickerOriginal: 'ORIG' }] }) }
        : (assert.equal(url.searchParams.get('ticker'), 'ORIG'), { ok: true, json: async () => ({ results: [{ pay_date: '2026-12-10', ex_dividend_date: '2026-11-10', cash_amount: 1, currency: 'USD' }] }) });
    const result = await assetDividends('cedear', 'LOCAL', 'secret', fetcher, now);
    assert.equal(result.symbol, 'ORIG');
    assert.equal(result.ratio, 10);
    assert.equal(result.events[0].amountPerShare, 1);
});
test('sin proveedor configurado o sin correspondencia informa disponibilidad', async () => {
    assert.deepEqual(await assetDividends('stock', 'AAPL', '', () => { throw new Error('unexpected'); }, now), { configured: false, status: 'unavailable', events: [] });
    const result = await assetDividends('cedear', 'XYZ', 'secret', async () => ({ ok: true, json: async () => ({ items: [] }) }), now);
    assert.equal(result.status, 'missing_ratio');
    assert.deepEqual(result.events, []);
    await assert.rejects(() => assetDividends('crypto', 'BTC', 'secret'));
});
