import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keySettings } from '../server/market-ai.mjs';

test('guarda claves cifradas por usuario y permite eliminarlas', async () => {
    let row = null;
    const db = { collection: () => ({
        findOne: async () => row,
        updateOne: async (filter, update) => {
            row ??= { _id: filter._id, keys: {} };
            if (update.$set) row.keys.openai = update.$set['keys.openai'];
            if (update.$unset) delete row.keys.openai;
        },
    }) };
    const env = { AI_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
    const user = { _id: 'user1' }, key = 'sk-secret-test-key';
    assert.deepEqual(await keySettings(db, user, env, { provider: 'openai', key }), { providers: ['openai'] });
    assert.ok(!JSON.stringify(row).includes(key));
    assert.deepEqual(await keySettings(db, user, env, { provider: 'openai', remove: true }), { providers: [] });
    await assert.rejects(keySettings(db, user, {}, { provider: 'openai', key }), /AI_ENCRYPTION_KEY/);
});
