import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPortfolio, validatePortfolio, readPortfolio, writePortfolio } from '../server/portfolio.mjs';

test('preserva posiciones cripto importadas con costo desconocido', () => {
    const portfolio = emptyPortfolio();
    const investment = { id: 'wallet-sol', name: 'Solana', kind: 'crypto', coin: 'solana', units: 0.004, currency: 'USD', amount: 0, costUnknown: true, date: '2026-11-05' };
    portfolio.investments = [investment];
    assert.deepEqual(validatePortfolio(portfolio).investments[0], investment);
    assert.throws(() => validatePortfolio({ ...portfolio, investments: [{ ...investment, costUnknown: undefined }] }));
    assert.throws(() => validatePortfolio({ ...portfolio, investments: [{ ...investment, amount: 10 }] }));
});

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
        ...['arg-stock', 'bond', 'fund'].map(assetKind => ({ id: assetKind, kind: 'price', assetKind, assetId: assetKind === 'fund' ? 'fondo~1~2' : 'YPFD', assetName: 'Activo local', threshold: 10, direction: 'above', date: '' })),
    ];
    assert.deepEqual(validatePortfolio(portfolio).alerts, portfolio.alerts);
    assert.throws(() => validatePortfolio({ ...portfolio, alerts: [...portfolio.alerts, portfolio.alerts[0]] }));
    assert.throws(() => validatePortfolio({ ...portfolio, alerts: [{ ...portfolio.alerts[1], date: '2026-02-30' }] }));
    assert.throws(() => validatePortfolio({ ...portfolio, alerts: [{ ...portfolio.alerts[0], threshold: -1 }] }));
    const dividend = { ...portfolio.alerts[1], id: 'dividend', kind: 'dividend', date: '', threshold: 0 };
    assert.equal(validatePortfolio({ ...portfolio, alerts: [dividend] }).alerts[0].threshold, 0);
    assert.equal(validatePortfolio({ ...portfolio, alerts: [{ ...dividend, threshold: 365 }] }).alerts[0].threshold, 365);
    assert.throws(() => validatePortfolio({ ...portfolio, alerts: [{ ...dividend, threshold: 1.5 }] }));
    assert.throws(() => validatePortfolio({ ...portfolio, alerts: [{ ...portfolio.alerts[0], threshold: 0 }] }));
});

test('guarda y recupera alertas de la cuenta, incluidas las modificaciones', async () => {
    const documents = new Map();
    const db = { collection: () => ({
        findOne: async ({ _id }) => documents.get(_id),
        insertOne: async doc => { documents.set(doc._id, structuredClone(doc)); },
        updateOne: async ({ _id, version }, { $set }) => {
            const doc = documents.get(_id);
            if (!doc || doc.version !== version) return { matchedCount: 0 };
            documents.set(_id, { ...doc, ...structuredClone($set) });
            return { matchedCount: 1 };
        },
    }) };
    const portfolio = emptyPortfolio();
    portfolio.alerts = [{ id: 'dividend', kind: 'dividend', assetKind: 'cedear', assetId: 'ITUB', assetName: 'Itau', threshold: 0, direction: 'above', date: '' }];
    await writePortfolio(db, 'alice', { portfolio, version: 0, mutationId: '00000000-0000-4000-8000-000000000001' });
    assert.deepEqual((await readPortfolio(db, 'alice')).portfolio.alerts, portfolio.alerts);
    assert.equal((await readPortfolio(db, 'bob')).portfolio.alerts, undefined);
    await writePortfolio(db, 'alice', { portfolio: { ...portfolio, alerts: [] }, version: 1, mutationId: '00000000-0000-4000-8000-000000000002' });
    assert.deepEqual((await readPortfolio(db, 'alice')).portfolio.alerts, []);
});

test('guarda y valida el horario de no molestar', () => {
    const portfolio = emptyPortfolio();
    portfolio.preferences.quietHours = { enabled: true, start: '22:00', end: '08:00' };
    assert.deepEqual(validatePortfolio(portfolio).preferences.quietHours, portfolio.preferences.quietHours);
    assert.throws(() => validatePortfolio({ ...portfolio, preferences: { ...portfolio.preferences, quietHours: { enabled: true, start: '22:00', end: '22:00' } } }));
    assert.throws(() => validatePortfolio({ ...portfolio, preferences: { ...portfolio.preferences, quietHours: { enabled: true, start: '25:00', end: '08:00' } } }));
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

test('guarda objetivos de distribución y valida que sumen 100', () => {
    const portfolio = emptyPortfolio();
    portfolio.preferences.allocationTargets = { rate: 30, cedear: 40, index: 0, stock: 0, crypto: 30 };
    assert.deepEqual(validatePortfolio(portfolio).preferences.allocationTargets, portfolio.preferences.allocationTargets);
    assert.throws(() => validatePortfolio({ ...portfolio, preferences: { ...portfolio.preferences, allocationTargets: { ...portfolio.preferences.allocationTargets, crypto: 29 } } }));
    assert.throws(() => validatePortfolio({ ...portfolio, preferences: { ...portfolio.preferences, allocationTargets: { ...portfolio.preferences.allocationTargets, crypto: -1 } } }));
});

test('conserva el vencimiento de un plazo fijo con tasa anual', () => {
    const portfolio = emptyPortfolio();
    portfolio.investments = [{ id: 'deposit', name: 'Plazo fijo', kind: 'rate', amount: 100000, currency: 'ARS', date: '2026-01-01', rate: 30, period: 'year', maturityDate: '2026-02-01' }];
    assert.deepEqual(validatePortfolio(portfolio).investments, portfolio.investments);
    assert.throws(() => validatePortfolio({ ...portfolio, investments: [{ ...portfolio.investments[0], maturityDate: '2025-12-31' }] }));
    assert.throws(() => validatePortfolio({ ...portfolio, investments: [{ ...portfolio.investments[0], period: 'month' }] }));
    assert.throws(() => validatePortfolio({ ...portfolio, investments: [{ ...portfolio.investments[0], rate: -1 }] }));
});
