import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPortfolio, validatePortfolio } from '../server/portfolio.mjs';

test('conserva ventas y preferencias del panel, y rechaza valores inválidos', () => {
    const portfolio = emptyPortfolio();
    portfolio.preferences.panels = ['inflation', 'investments'];
    portfolio.sales = [{ id: 'sale-1', name: 'Inversión', date: '2026-01-01', fraction: 0.5, proceeds: 300, currency: 'ARS', cost: 2, costCurrency: 'USD' }];
    assert.deepEqual(validatePortfolio(portfolio), portfolio);
    assert.deepEqual(validatePortfolio({ ...portfolio, preferences: { ...portfolio.preferences, panels: ['streak', 'macro', 'panel-v2'] } }).preferences.panels, ['streak', 'macro', 'panel-v2']);
    assert.throws(() => validatePortfolio({ ...portfolio, sales: [{ ...portfolio.sales[0], fraction: 1.1 }] }));
    assert.throws(() => validatePortfolio({ ...portfolio, preferences: { ...portfolio.preferences, panels: ['unknown'] } }));
    assert.throws(() => validatePortfolio({ ...portfolio, sales: [{ ...portfolio.sales[0], date: '2026-02-30' }] }));
});

test('acciones se guardan en USD y se conservan CEDEARs anteriores en USD', () => {
    const portfolio = emptyPortfolio();
    portfolio.investments = [
        { id: 'stock', name: 'Apple', kind: 'stock', coin: 'AAPL', units: 1, amount: 200, currency: 'USD', date: '2026-01-01' },
        { id: 'legacy', name: 'CEDEAR anterior', kind: 'cedear', coin: 'AAPL', units: 1, amount: 10, currency: 'USD', date: '2026-01-01' },
    ];
    assert.deepEqual(validatePortfolio(portfolio).investments, portfolio.investments);
    portfolio.investments[0].currency = 'ARS';
    assert.throws(() => validatePortfolio(portfolio));
});
