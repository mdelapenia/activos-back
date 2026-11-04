import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localQuotes } from '../../front/src/local-market.ts';
import { emptyPortfolio, validatePortfolio } from '../server/portfolio.mjs';

test('normaliza bonos por 100 nominales y selecciona la clase exacta del fondo', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async url => ({ ok: true, json: async () => String(url).includes('/fci/') ? { fondos: [ { fondoId: '1', claseId: '2', rendimientos: { valorCuotaparte: 7 } }, { fondoId: '1', claseId: '3', rendimientos: { valorCuotaparte: 99 } } ] } : [{ symbol: 'AL30', c: 85000 }] });
    try {
        const result = await localQuotes([{ kind: 'bond', coin: 'AL30' }, { kind: 'fund', coin: 'fondo-a~1~2' }]);
        assert.equal(result['bond:AL30'], 850);
        assert.equal(result['fund:fondo-a~1~2'], 7);
    } finally { globalThis.fetch = original; }
});

test('guarda los tres instrumentos en pesos y rechaza moneda incorrecta', () => {
    const portfolio = emptyPortfolio();
    portfolio.investments = ['arg-stock', 'bond', 'fund'].map((kind, i) => ({ id: String(i), kind, coin: kind === 'fund' ? 'fondo~1~2' : 'AL30', name: 'Ejemplo', currency: 'ARS', date: '2026-01-01', amount: 1000, units: 2 }));
    assert.deepEqual(validatePortfolio(portfolio).investments, portfolio.investments);
    assert.throws(() => validatePortfolio({ ...portfolio, investments: [{ ...portfolio.investments[0], currency: 'USD' }] }));
});
