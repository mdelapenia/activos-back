import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localQuotes } from '../../front/src/local-market.ts';
import { loadPriceQuotes } from '../server/push.mjs';
import { emptyPortfolio, validatePortfolio } from '../server/portfolio.mjs';

const lecap = { id: 'l1', kind: 'lecap', coin: 'S30N6', name: 'LECAP S30N6', currency: 'ARS', date: '2026-01-01', amount: 120000, units: 100000 };

test('guarda LECAPs en pesos y rechaza otra moneda', () => {
    const portfolio = { ...emptyPortfolio(), investments: [lecap] };
    assert.deepEqual(validatePortfolio(portfolio).investments, [lecap]);
    assert.throws(() => validatePortfolio({ ...portfolio, investments: [{ ...lecap, currency: 'USD' }] }));
});

test('acepta alertas y objetivos de distribución para LECAPs', () => {
    const portfolio = emptyPortfolio();
    portfolio.alerts = [{ id: 'a1', kind: 'price', assetKind: 'lecap', assetId: 'S30N6', assetName: 'S30N6', threshold: 1.3, direction: 'above', date: '' }];
    portfolio.preferences = { ...portfolio.preferences, allocationTargets: { rate: 20, cedear: 20, index: 20, stock: 10, crypto: 10, lecap: 20 } };
    const result = validatePortfolio(portfolio);
    assert.equal(result.alerts[0].assetKind, 'lecap');
    assert.equal(result.preferences.allocationTargets.lecap, 20);
});

test('cotiza LECAPs desde las letras de Data912, por 1 nominal', async () => {
    const original = globalThis.fetch;
    let requested = '';
    globalThis.fetch = async url => { requested = String(url); return { ok: true, json: async () => [{ symbol: 'S30N6', c: 128.88 }] }; };
    try {
        const result = await localQuotes([{ kind: 'lecap', coin: 'S30N6' }]);
        assert.match(requested, /\/live\/arg_notes$/);
        assert.equal(result['lecap:S30N6'], 1.2888);
    } finally { globalThis.fetch = original; }
});

test('las alertas de precio de LECAPs usan las letras de Data912', async () => {
    let requested = '';
    const quotes = await loadPriceQuotes([{ assetKind: 'lecap', assetId: 'S30N6' }], async url => { requested = url; return { ok: true, json: async () => [{ symbol: 'S30N6', c: 128.88 }] }; });
    assert.match(requested, /\/live\/arg_notes$/);
    assert.deepEqual(quotes, { 'lecap:S30N6': 1.2888 });
});
