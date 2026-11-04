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

test('conserva operaciones importadas junto a la cartera y rechaza IDs repetidos', () => {
    const portfolio = emptyPortfolio();
    portfolio.imports = [{ id: 'op-1', status: 'pending', source: 'comprobante.pdf', asset: 'ITUB', name: 'ITUB', kind: 'stock', side: 'buy', date: '2026-01-02', quantity: '0.123456789012345678', price: '4.2', amount: '0.5185185138518518476', currency: 'USD', fee: '0', externalId: 'order-1', executions: '[{"executionId":"a"}]' }];
    assert.deepEqual(validatePortfolio(portfolio).imports, portfolio.imports);
    portfolio.imports.push({ ...portfolio.imports[0] });
    assert.throws(() => validatePortfolio(portfolio));
});

test('conserva alertas y rechaza configuraciones inválidas', () => {
    const portfolio = emptyPortfolio();
    portfolio.alerts = [
        { id: 'price', kind: 'price', assetKind: 'crypto', assetId: 'bitcoin', assetName: 'Bitcoin', threshold: 100000, direction: 'above', date: '' },
        { id: 'maturity', kind: 'maturity', assetKind: 'stock', assetId: 'AAPL', assetName: 'Apple', threshold: 7, direction: 'above', date: '2026-12-15' },
    ];
    assert.deepEqual(validatePortfolio(portfolio).alerts, portfolio.alerts);
    assert.throws(() => validatePortfolio({ ...portfolio, alerts: [...portfolio.alerts, portfolio.alerts[0]] }));
    assert.throws(() => validatePortfolio({ ...portfolio, alerts: [{ ...portfolio.alerts[1], date: '2026-02-30' }] }));
    assert.throws(() => validatePortfolio({ ...portfolio, alerts: [{ ...portfolio.alerts[0], threshold: -1 }] }));
});

test('conserva precio ejecutado, unidades y comisión de una venta', () => {
    const portfolio = emptyPortfolio();
    const sale = { id: 'sale', name: 'Apple', date: '2026-01-01', fraction: 0.5, proceeds: 98, currency: 'USD', cost: 80, costCurrency: 'USD', executionPrice: 50, units: 2, fee: 2 };
    portfolio.sales = [sale];
    assert.deepEqual(validatePortfolio(portfolio).sales, [sale]);
    assert.throws(() => validatePortfolio({ ...portfolio, sales: [{ ...sale, fee: -1 }] }));
    assert.throws(() => validatePortfolio({ ...portfolio, sales: [{ ...sale, executionPrice: 0 }] }));
    assert.throws(() => validatePortfolio({ ...portfolio, sales: [{ ...sale, units: 0 }] }));
});
