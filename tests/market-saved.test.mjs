import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketSaved, MAX_RECENT_SEARCHES } from '../server/market-saved.mjs';

// Base en memoria con lo mínimo que usa el módulo (upsert con $set).
function memoryDb() {
    const rows = new Map();
    return { rows, collection: () => ({
        findOne: async ({ _id }) => rows.get(_id) ?? null,
        updateOne: async ({ _id }, { $set }) => { rows.set(_id, { _id, ...(rows.get(_id) ?? {}), ...$set }); },
    }) };
}
const btc = { assetKind: 'crypto', assetId: 'bitcoin', assetName: 'Bitcoin', symbol: 'BTC' };
const lecap = { assetKind: 'lecap', assetId: 'S30N6', assetName: 'S30N6', symbol: 'S30N6' };

test('sin datos guardados devuelve listas vacías', async () => {
    assert.deepEqual(await marketSaved(memoryDb(), { _id: 'u1' }, null), { favorites: [], recentSearches: [] });
});

test('guarda favoritos y búsquedas por separado, sin pisar el otro campo', async () => {
    const db = memoryDb();
    await marketSaved(db, { _id: 'u1' }, { favorites: [btc] }, 1000);
    const result = await marketSaved(db, { _id: 'u1' }, { recentSearches: ['  aapl ', 'S30N6'] }, 2000);
    assert.deepEqual(result, { favorites: [btc], recentSearches: ['aapl', 'S30N6'] });
    assert.equal(db.rows.get('u1').updatedAt.getTime(), 2000);
    assert.deepEqual(await marketSaved(db, { _id: 'u2' }, null), { favorites: [], recentSearches: [] });
});

test('descarta campos extra de cada favorito', async () => {
    const result = await marketSaved(memoryDb(), { _id: 'u1' }, { favorites: [{ ...lecap, price: 1.28 }] });
    assert.deepEqual(result.favorites, [lecap]);
});

test('rechaza datos inválidos', async () => {
    const db = memoryDb();
    for (const body of [
        {}, [], { other: [] },
        { favorites: [{ ...btc, assetKind: 'rate' }] },
        { favorites: [btc, { ...btc, assetId: 'BITCOIN' }] },
        { favorites: 'btc' },
        { recentSearches: Array.from({ length: MAX_RECENT_SEARCHES + 1 }, (_, i) => `q${i}`) },
        { recentSearches: [''] },
        { recentSearches: ['x'.repeat(151)] },
    ]) await assert.rejects(marketSaved(db, { _id: 'u1' }, body), { status: 400 });
    assert.equal(db.rows.size, 0);
});
