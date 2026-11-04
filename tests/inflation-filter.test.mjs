import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetsInflation } from '../../front/src/inflation-filter.ts';
test('compara rendimientos en pesos con tolerancia de cinco puntos', () => {
    assert.equal(meetsInflation(100, 121, 25), true);
    assert.equal(meetsInflation(100, 120, 25), true);
    assert.equal(meetsInflation(100, 119, 25), false);
    assert.equal(meetsInflation(0, 120, 25), false);
    assert.equal(meetsInflation(100, NaN, 25), false);
});
