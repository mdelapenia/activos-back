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

test('incluye dividendos de ETF de índices registrados como CEDEARs', async () => {
    const investments = ['SPY', 'QQQ'].map((coin, index) => ({ id: String(index), name: coin, kind: 'cedear', coin, units: 60, date: '2025-01-01' }));
    const symbols = [];
    const fetcher = async url => {
        if (String(url).includes('cedears.json')) return { ok: true, json: async () => ({ items: [{ Cedears: 'SPY', Ratio: '60', TickerOriginal: 'SPY' }, { Cedears: 'QQQ', Ratio: '20', TickerOriginal: 'QQQ' }] }) };
        symbols.push(url.searchParams.get('ticker'));
        return { ok: true, json: async () => ({ results: [{ pay_date: '2099-02-01', ex_dividend_date: '2099-01-03', cash_amount: 2, currency: 'USD' }] }) };
    };
    const { items } = await portfolioDividends({ investments }, 'secret', fetcher);
    assert.deepEqual(symbols.sort(), ['QQQ', 'SPY']);
    assert.equal(items[0].events[0].estimatedGross, 2);
    assert.equal(items[1].events[0].estimatedGross, 6);
});

test('incluye acciones y SPY sin ratios de CEDEAR y calcula unidades fraccionarias', async () => {
    const investments = ['SPY', 'AAPL'].map((coin, index) => ({ id: String(index), name: coin, kind: 'stock', coin, units: 0.5, date: '2025-01-01' }));
    const symbols = [];
    const fetcher = async url => { symbols.push(url.searchParams.get('ticker')); return { ok: true, json: async () => ({ results: [{ pay_date: '2099-02-01', ex_dividend_date: '2099-01-03', cash_amount: 2, currency: 'USD' }] }) }; };
    const { items } = await portfolioDividends({ investments }, 'secret', fetcher);
    assert.deepEqual(symbols.sort(), ['AAPL', 'SPY']);
    assert.equal(items[0].events[0].estimatedGross, 1);
    assert.equal(items[0].kind, 'stock');
});
