import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPortfolio, validatePortfolio } from '../server/portfolio.mjs';

test('conserva ventas y preferencias del panel, y rechaza valores inválidos', () => {
    const portfolio = emptyPortfolio();
    portfolio.preferences.panels = ['inflation', 'investments'];
    portfolio.sales = [{ id: 'sale-1', name: 'Inversión', date: '2026-01-01', fraction: 0.5, proceeds: 300, currency: 'ARS', cost: 2, costCurrency: 'USD' }];
    assert.deepEqual(validatePortfolio(portfolio), portfolio);
    assert.throws(() => validatePortfolio({ ...portfolio, sales: [{ ...portfolio.sales[0], fraction: 1.1 }] }));
    assert.throws(() => validatePortfolio({ ...portfolio, preferences: { ...portfolio.preferences, panels: ['unknown'] } }));
    assert.throws(() => validatePortfolio({ ...portfolio, sales: [{ ...portfolio.sales[0], date: '2026-02-30' }] }));
});
