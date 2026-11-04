import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider, keySettings, marketChat } from '../server/market-ai.mjs';

test('detecta el proveedor por el formato sin confundir Claude con OpenAI', () => {
    assert.equal(detectProvider('sk-ant-test'), 'claude');
    assert.equal(detectProvider('sk-proj-test'), 'openai');
    assert.equal(detectProvider('AIza-test'), 'gemini');
    assert.equal(detectProvider('AQ.example-auth-key'), 'gemini');
    assert.equal(detectProvider('desconocida'), null);
});

test('el asistente pide investigar y construir escenarios sin inventar cotizaciones', async () => {
    let row;
    const db = { collection: () => ({ findOne: async () => row, updateOne: async (filter, update) => { row = { _id: filter._id, keys: { gemini: update.$set['keys.gemini'] } }; } }) };
    const env = { AI_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
    const user = { _id: 'user1' };
    await keySettings(db, user, env, { key: 'AQ.example-auth-key' });
    const originalFetch = globalThis.fetch;
    let payload;
    globalThis.fetch = async (_url, options) => { payload = JSON.parse(options.body); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Escenario estimado' }] } }] }) }; };
    try {
        const result = await marketChat(db, user, env, { provider: 'gemini', messages: [{ role: 'user', content: '¿Cuál es tu predicción para ITUB?' }], assets: ['Itaú (ITUB) · cedear'] });
        assert.equal(result.text, 'Escenario estimado');
        assert.match(payload.system_instruction.parts[0].text, /no te niegues solo porque es incierto/);
        assert.match(payload.system_instruction.parts[0].text, /sin inventar cifras/);
        assert.deepEqual(payload.tools, [{ google_search: {} }]);
        await marketChat(db, user, env, { provider: 'gemini', messages: [{ role: 'user', content: 'Predicción de ITUB' }, { role: 'assistant', content: 'No realizo predicciones de precios.' }, { role: 'user', content: 'Dame una predicción de ITUB a un año' }], assets: ['ITUB'] });
        assert.equal(payload.contents.length, 1);
        assert.match(payload.contents[0].parts[0].text, /un año/);
    } finally { globalThis.fetch = originalFetch; }
});

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
    assert.deepEqual(await keySettings(db, user, env, { key }), { providers: ['openai'], masks: { openai: 'sk-*****' }, provider: 'openai' });
    assert.ok(!JSON.stringify(row).includes(key));
    assert.deepEqual(await keySettings(db, user, env, { provider: 'openai', copy: true }), { key });
    await assert.rejects(keySettings(db, user, env, { key, expectedProvider: 'claude' }), /proveedor seleccionado/);
    assert.deepEqual(await keySettings(db, user, env, { provider: 'openai', remove: true }), { providers: [], masks: {}, provider: 'openai' });
    await assert.rejects(keySettings(db, user, {}, { provider: 'openai', key }), /AI_ENCRYPTION_KEY/);
});
