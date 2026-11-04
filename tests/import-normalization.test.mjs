import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDecimals, decimal, groupExecutions, operationFingerprint } from '../server/import-normalization.mjs';

test('suma ejecuciones de una orden sin redondeo binario y separa órdenes', () => {
    const orders = groupExecutions([
        { orderId: 'ITUB-1', executionId: 'a', quantity: '0.123456789012345678', price: '4.2', amount: '0.5185185138518518476', fee: '0.001' },
        { orderId: 'ITUB-1', executionId: 'b', quantity: '0.876543210987654322', price: '4.3', amount: '3.7691358072469135846', fee: '0.002' },
        { orderId: 'ITUB-2', executionId: 'a', quantity: '1', price: '4.3', amount: '4.3' },
    ]);
    assert.equal(orders.length, 2);
    assert.equal(orders[0].quantity, '1');
    assert.equal(orders[0].amount, '4.2876543210987654322');
    assert.equal(orders[0].fee, '0.003');
    assert.throws(() => groupExecutions([{ orderId: 'x', quantity: '1' }]));
});

test('normaliza decimales y detecta candidatos entre fuentes sin depender de formato', () => {
    assert.equal(addDecimals(['0.1', '0.2']), '0.3');
    assert.throws(() => decimal('1e-8'));
    const op = { asset: 'itub', side: 'buy', date: '2026-01-02', currency: 'USD', quantity: '01.00', amount: '4.300' };
    assert.equal(operationFingerprint(op), operationFingerprint({ ...op, asset: 'ITUB', quantity: '1', amount: '4.3' }));
    assert.notEqual(operationFingerprint(op), operationFingerprint({ ...op, side: 'sell' }));
});
