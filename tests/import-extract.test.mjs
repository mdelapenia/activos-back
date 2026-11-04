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

test('usa las claves del chat y envía el archivo con el formato de cada proveedor', async () => {
    const doc = { keys: {} };
    const db = { collection: () => ({ findOne: async () => doc, updateOne: async (_, update) => { for (const [key, value] of Object.entries(update.$set)) doc.keys[key.split('.')[1]] = value; } }) };
    const user = { _id: 'user-1' }, env = { AI_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), OPENROUTER_API_KEY: 'shared-router-key' };
    await keySettings(db, user, env, { key: 'sk-ant-example-key' });
    await keySettings(db, user, env, { key: 'AIza-example-key' });
    const file = Buffer.from('%PDF-1.4\nexample').toString('base64');
    for (const [provider, host] of [['claude', 'api.anthropic.com'], ['gemini', 'generativelanguage.googleapis.com'], ['openrouter', 'openrouter.ai']]) {
        const result = await extractDocument(db, user, env, { provider, type: 'application/pdf', data: file }, async (url, options) => {
            assert.equal(new URL(url).host, host); const payload = JSON.parse(options.body);
            if (provider === 'claude') { assert.equal(options.headers['x-api-key'], 'sk-ant-example-key'); assert.equal(payload.messages[0].content[0].type, 'document'); return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"operations":[]}' }] }) }; }
            if (provider === 'gemini') { assert.equal(options.headers['x-goog-api-key'], 'AIza-example-key'); assert.equal(payload.contents[0].parts[0].inline_data.mime_type, 'application/pdf'); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"operations":[]}' }] } }] }) }; }
            assert.equal(options.headers.Authorization, 'Bearer shared-router-key'); assert.equal(payload.plugins[0].pdf.engine, 'cloudflare-ai'); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"operations":[]}' } }] }) };
        });
        assert.deepEqual(result.operations, []);
    }
    await assert.rejects(() => extractDocument(db, user, env, { provider: 'invalid', type: 'application/pdf', data: file }), /Proveedor/);
});
