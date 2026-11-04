import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDocument } from '../server/import-extract.mjs';
import { keySettings } from '../server/market-ai.mjs';

test('el lector valida el contenido y envía el PDF para extraer operaciones sin modificar la cartera', async () => {
    let document = null; let calls = 0;
    const db = { collection(name) { assert.equal(name, 'ai_keys'); return { findOne: async () => document, updateOne: async (_, update) => { document = { keys: { openai: update.$set['keys.openai'] } }; } }; } };
    const user = { _id: 'user-1' }, env = { AI_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
    await keySettings(db, user, env, { key: 'sk-test-example-key' });
    const file = Buffer.from('%PDF-1.4\nexample').toString('base64');
    const result = await extractDocument(db, user, env, { type: 'application/pdf', data: file }, async (_url, options) => {
        calls++; const payload = JSON.parse(options.body);
        assert.equal(payload.store, false); assert.equal(payload.input[0].content[0].type, 'input_file');
        return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: '{"operations":[{"asset":"ITUB"}]}' }] }] }) };
    });
    assert.deepEqual(result.operations, [{ asset: 'ITUB' }]); assert.equal(calls, 1);
    await assert.rejects(() => extractDocument(db, user, env, { type: 'image/png', data: file }), /contenido/);
});
