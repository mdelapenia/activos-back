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
        assert.match(payload.system_instruction.parts[0].text, /menos de 35 palabras/);
        assert.match(payload.system_instruction.parts[0].text, /propuesta concreta y razonada/);
        assert.match(payload.system_instruction.parts[0].text, /no afirmes que existe concentración/);
        assert.match(payload.system_instruction.parts[0].text, /horizonte \(corto, medio o largo plazo\)/);
        assert.match(payload.system_instruction.parts[0].text, /No hagas un cuestionario para consultas informativas simples/);
        assert.deepEqual(payload.tools, [{ google_search: {} }]);
        await marketChat(db, user, env, { provider: 'gemini', messages: [{ role: 'user', content: 'Predicción de ITUB' }, { role: 'assistant', content: 'No realizo predicciones de precios.' }, { role: 'user', content: 'Dame una predicción de ITUB a un año' }], assets: ['ITUB'] });
        assert.equal(payload.contents.length, 3);
        assert.match(payload.contents[2].parts[0].text, /un año/);
        assert.match(payload.system_instruction.parts[0].text, /Usá el contexto de la conversación reciente/);
        assert.match(payload.system_instruction.parts[0].text, /no afirmes que lo hiciste/);
        assert.match(payload.system_instruction.parts[0].text, /exactamente una pregunta breve por mensaje/);
        assert.match(payload.system_instruction.parts[0].text, /máximo 90 palabras/);
        assert.match(payload.system_instruction.parts[0].text, /pérdidas pueden superar el porcentaje tolerado/);
        assert.match(payload.system_instruction.parts[0].text, /saltá las preguntas ya respondidas/);
        await marketChat(db, user, env, { provider: 'gemini', messages: [{ role: 'assistant', content: 'Mensaje anterior' }, { role: 'user', content: 'Primera consulta' }, { role: 'user', content: 'Reintento' }], assets: [] });
        assert.equal(payload.contents.length, 1);
        assert.match(payload.contents[0].parts[0].text, /Primera consulta[\s\S]*Reintento/);
        globalThis.fetch = async () => ({ ok: false, status: 429 });
        await assert.rejects(marketChat(db, user, env, { provider: 'gemini', messages: [{ role: 'user', content: 'QQQ' }] }), /Gemini alcanzó un límite/);
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


test('OpenRouter usa exclusivamente el selector gratuito y acepta una clave compartida', async () => {
    const db = { collection: () => ({ findOne: async () => null }) };
    const env = { OPENROUTER_API_KEY: 'sk-or-test-key' };
    const user = { _id: 'user1' };
    assert.equal(detectProvider('sk-or-test-key'), 'openrouter');
    assert.deepEqual(await keySettings(db, user, env, null), { providers: ['openrouter'], masks: {}, sharedProviders: ['openrouter'] });
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async (url, options) => {
            assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
            assert.equal(JSON.parse(options.body).model, 'openrouter/free');
            return { ok: true, json: async () => ({ choices: [{ message: { content: 'Hola' } }] }) };
        };
        const result = await marketChat(db, user, env, { provider: 'openrouter', messages: [{ role: 'user', content: 'Hola' }] });
        assert.equal(result.text, 'Hola');
    } finally { globalThis.fetch = originalFetch; }
});


test('OpenRouter reintenta si el modelo devuelve una llamada interna en vez de una respuesta', async () => {
    const db = { collection: () => ({ findOne: async () => null }) };
    const originalFetch = globalThis.fetch; let calls = 0;
    try {
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: ++calls === 1 ? "<|tool_call_start|>[google(query='QQQ')]<|tool_call_end|>" : 'Podés considerar una cartera diversificada.' } }] }) });
        const result = await marketChat(db, { _id: 'u' }, { OPENROUTER_API_KEY: 'sk-or-test' }, { provider: 'openrouter', messages: [{ role: 'user', content: '¿Cómo invierto?' }] });
        assert.equal(calls, 2);
        assert.equal(result.text, 'Podés considerar una cartera diversificada.');
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '<|tool_call_start|>google()<|tool_call_end|>' } }] }) });
        await assert.rejects(marketChat(db, { _id: 'u' }, { OPENROUTER_API_KEY: 'sk-or-test' }, { provider: 'openrouter', messages: [{ role: 'user', content: '¿Cómo invierto?' }] }), /respuesta válida/);
    } finally { globalThis.fetch = originalFetch; }
});


test('OpenRouter intenta resumir una recomendación de inversión extensa', async () => {
    const db = { collection: () => ({ findOne: async () => null }) };
    const originalFetch = globalThis.fetch; let calls = 0;
    try {
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: ++calls === 1 ? 'Detalle '.repeat(160) : 'Dos opciones, con sus riesgos.' } }] }) });
        const result = await marketChat(db, { _id: 'u' }, { OPENROUTER_API_KEY: 'sk-or-test' }, { provider: 'openrouter', messages: [{ role: 'user', content: 'Quiero invertir' }] });
        assert.equal(calls, 2);
        assert.equal(result.text, 'Dos opciones, con sus riesgos.');
    } finally { globalThis.fetch = originalFetch; }
});
