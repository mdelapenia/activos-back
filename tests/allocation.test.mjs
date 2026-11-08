import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateAllocation } from '../../front/src/allocation.ts';

test('calcula el aporte mínimo para alcanzar la distribución sin vender', () => {
    const values = { rate: 20, cedear: 60, index: 0, stock: 0, crypto: 20 };
    const targets = { rate: 30, cedear: 40, index: 0, stock: 0, crypto: 30 };
    const result = calculateAllocation(values, targets);
    assert.equal(result.total, 100);
    assert.equal(result.totalContribution, 50);
    assert.deepEqual(result.contributions, { rate: 25, cedear: 0, index: 0, stock: 0, crypto: 25, 'arg-stock': 0, bond: 0, fund: 0, morpho: 0 });
});

test('detecta posiciones con objetivo cero e impide cálculos con valores inválidos', () => {
    const values = { rate: 20, cedear: 60, index: 0, stock: 0, crypto: 20 };
    const targets = { rate: 40, cedear: 60, index: 0, stock: 0, crypto: 0 };
    assert.deepEqual(calculateAllocation(values, targets).blocked, ['crypto']);
    assert.equal(calculateAllocation(values, targets).contributions, null);
    assert.equal(calculateAllocation({ ...values, rate: NaN }, targets), null);
    assert.equal(calculateAllocation(values, { ...targets, rate: 30 }), null);
});
