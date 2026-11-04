import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixedTermValue } from '../../front/src/fixed-term.ts';
test('calcula interés simple por días y detiene la acumulación al vencimiento', () => {
    const time = value => new Date(`${value}T12:00:00`).getTime();
    assert.equal(fixedTermValue(100000, 36.5, '2026-01-01', '2026-01-31', time('2025-12-31')), 0);
    assert.equal(fixedTermValue(100000, 36.5, '2026-01-01', '2026-01-31', time('2026-01-01')), 100000);
    assert.equal(fixedTermValue(100000, 36.5, '2026-01-01', '2026-01-31', time('2026-01-31')), 103000);
    assert.equal(fixedTermValue(100000, 36.5, '2026-01-01', '2026-01-31', time('2026-03-01')), 103000);
});
