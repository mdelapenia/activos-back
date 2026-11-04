import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractDocument, parseAlpaca, parseLemon } from '../server/import-extract.mjs';

test('lee el PDF de ejemplo y agrupa las ejecuciones por orden', async () => {
    const data = (await readFile(new URL('../../front/public/Resumen de operaciones 2026-11-02.pdf', import.meta.url))).toString('base64');
    const { operations } = await extractDocument(null, null, null, { type:'application/pdf', data });
    assert.deepEqual(operations.map(o => [o.asset, o.quantity, o.amount, o.executions.length]), [['SPY','0.046897527','35.65',1], ['ITUB','3.292978006','23.76',2]]);
});

test('lee la captura de Lemon sin proveedor externo', async () => {
    const data = (await readFile(new URL('../../front/public/screencapture-mail-google-com-mail-u-0-2026-11-04-10_08_43.png', import.meta.url))).toString('base64');
    const { operations } = await extractDocument(null, null, null, { type:'image/png', data });
    const op = operations[0];
    assert.deepEqual([op.asset, op.date, op.quantity, op.amount, op.currency, op.price, op.fee], ['solana','2026-11-02','0.00151474','241.08','ARS','158357.03595','1.21']);
    assert.equal(op.externalId, null);
});

test('ignora textos desconocidos y valida el formato declarado', async () => {
    assert.deepEqual(parseAlpaca('posiciones SPY 100'), []);
    assert.deepEqual(parseLemon('Compraste SOL'), []);
    const data = Buffer.from('%PDF-1.4\nexample').toString('base64');
    await assert.rejects(() => extractDocument(null, null, null, {type:'image/png', data}), /contenido/);
});
