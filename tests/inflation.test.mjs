import test from 'node:test';
import assert from 'node:assert/strict';
import { inflationFromBls } from '../server/inflation.mjs';
test('calcula variaciones mensuales e interanuales y omite promedios anuales', () => {
    const data = [{ year: '2025', period: 'M01', value: '110' }, { year: '2024', period: 'M12', value: '108' }, { year: '2024', period: 'M01', value: '100' }, { year: '2024', period: 'M13', value: '500' }];
    const result = inflationFromBls({ status: 'REQUEST_SUCCEEDED', Results: { series: [{ seriesID: 'CUUR0000SA0', data }] } });
    assert.equal(result.monthly.length, 1);
    assert.ok(Math.abs(result.monthly[0].valor - 100 * (110 / 108 - 1)) < 1e-9);
    assert.ok(Math.abs(result.yearly[0].valor - 10) < 1e-9);
    assert.equal(result.yearly[0].fecha, '2025-01-01');
});
test('rechaza respuestas fallidas de BLS', () => assert.throws(() => inflationFromBls({ status: 'REQUEST_FAILED' })));
