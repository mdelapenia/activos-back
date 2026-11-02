import test from 'node:test';
import assert from 'node:assert/strict';
import { portfolioDividends } from '../server/dividends.mjs';

test('calcula dividendos por CEDEAR y señala compras posteriores al corte', async () => {
    const portfolio = { investments: [
        { id: 'a', name: 'Apple', kind: 'cedear', coin: 'AAPL', units: 40, date: '2025-01-01' },
        { id: 'b', name: 'Apple nueva', kind: 'cedear', coin: 'AAPL', units: 20, date: '2099-01-04' },
        { id: 'c', name: 'Desconocido', kind: 'cedear', coin: 'UNKNOWN', units: 1, date: '2025-01-01' },
    ] };
    const fetcher = async url => ({ ok: true, json: async () => String(url).includes('cedears.json')
        ? { items: [{ Cedears: 'AAPL', Ratio: '20', TickerOriginal: 'AAPL' }] }
        : { results: [{ pay_date: '2099-02-01', ex_dividend_date: '2099-01-03', cash_amount: 0.5, currency: 'USD' }] } });
    const result = await portfolioDividends(portfolio, 'secret', fetcher);
    assert.equal(result.items[0].events[0].estimatedGross, 1);
    assert.equal(result.items[0].events[0].eligible, true);
    assert.equal(result.items[1].events[0].eligible, false);
    assert.equal(result.items[2].status, 'missing_ratio');
    assert.doesNotMatch(JSON.stringify(result), /secret/);
    assert.deepEqual(await portfolioDividends(portfolio, ''), { configured: false, items: [] });
});
