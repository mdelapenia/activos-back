import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError } from './security.mjs';

const providers = ['openai', 'claude', 'gemini'];
function masterKey(env) {
    const encoded = env.AI_ENCRYPTION_KEY || '';
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) throw new HttpError(503, 'Falta configurar AI_ENCRYPTION_KEY en el servidor.');
    return key;
}
function encrypt(value, env, userId, provider) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', masterKey(env), iv);
    cipher.setAAD(Buffer.from(`${userId}:${provider}`));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function decrypt(value, env, userId, provider) {
    const cipher = createDecipheriv('aes-256-gcm', masterKey(env), Buffer.from(value.iv, 'base64'));
    cipher.setAAD(Buffer.from(`${userId}:${provider}`)); cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8');
}
export async function keySettings(db, user, env, body) {
    if (!body) {
        const row = await db.collection('ai_keys').findOne({ _id: user._id });
        return { providers: providers.filter(p => row?.keys?.[p]) };
    }
    const { provider, key, remove } = body;
    if (!providers.includes(provider)) throw new HttpError(400, 'Proveedor inválido.');
    if (remove === true) await db.collection('ai_keys').updateOne({ _id: user._id }, { $unset: { [`keys.${provider}`]: '' } });
    else {
        if (typeof key !== 'string' || key.trim().length < 10 || key.length > 512 || /\s/.test(key)) throw new HttpError(400, 'Ingresá una API key válida.');
        await db.collection('ai_keys').updateOne({ _id: user._id }, { $set: { [`keys.${provider}`]: encrypt(key, env, user._id, provider) } }, { upsert: true });
    }
    return keySettings(db, user, env);
}
export async function marketChat(db, user, env, body) {
    const { provider, messages, assets } = body || {};
    if (!providers.includes(provider) || !Array.isArray(messages) || !messages.length || messages.length > 20 || messages.some(m => !['user', 'assistant'].includes(m?.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 4000) || messages.at(-1).role !== 'user') throw new HttpError(400, 'La conversación no es válida.');
    const row = await db.collection('ai_keys').findOne({ _id: user._id });
    if (!row?.keys?.[provider]) throw new HttpError(400, 'Agregá una API key para este proveedor.');
    const key = decrypt(row.keys[provider], env, user._id, provider);
    const names = Array.isArray(assets) ? assets.filter(x => typeof x === 'string').slice(0, 40).map(x => x.slice(0, 100)).join(', ') : '';
    const system = `Sos un asistente de mercado para una persona en Argentina. Respondé en español claro, distinguí hechos de estimaciones, indicá fecha y moneda de las cotizaciones y citá fuentes. No afirmes tener datos actuales sin consultarlos. Activos indicados por el usuario: ${names || 'ninguno'}. No conocés sus cantidades ni saldos.`;
    let url, headers = { 'Content-Type': 'application/json' }, payload;
    if (provider === 'openai') { url = 'https://api.openai.com/v1/responses'; headers.Authorization = `Bearer ${key}`; payload = { model: env.OPENAI_CHAT_MODEL || 'gpt-5-mini', instructions: system, input: messages, tools: [{ type: 'web_search' }], store: false }; }
    else if (provider === 'claude') { url = 'https://api.anthropic.com/v1/messages'; headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; payload = { model: env.CLAUDE_CHAT_MODEL || 'claude-sonnet-4-6', max_tokens: 2048, system, messages, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] }; }
    else { url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash')}:generateContent`; headers['x-goog-api-key'] = key; payload = { system_instruction: { parts: [{ text: system }] }, contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), tools: [{ google_search: {} }] }; }
    let response;
    try { response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(90_000) }); } catch { throw new HttpError(503, 'No se pudo conectar con el proveedor de IA.'); }
    if (!response.ok) throw new HttpError(response.status === 401 || response.status === 403 ? 400 : 503, response.status === 401 || response.status === 403 ? 'El proveedor rechazó la API key o no tiene acceso al modelo.' : 'El proveedor no pudo responder. Revisá tu cuota y volvé a intentar.');
    const data = await response.json(); let text = '', citations = [];
    if (provider === 'openai') for (const item of data.output || []) for (const part of item.content || []) { if (part.type === 'output_text') { text += part.text; citations.push(...(part.annotations || []).filter(a => a.type === 'url_citation').map(a => ({ url: a.url, title: a.title }))); } }
    else if (provider === 'claude') for (const part of data.content || []) { if (part.type === 'text') { text += part.text; citations.push(...(part.citations || []).filter(a => a.url).map(a => ({ url: a.url, title: a.title }))); } }
    else { const candidate = data.candidates?.[0]; text = (candidate?.content?.parts || []).map(p => p.text || '').join(''); citations = (candidate?.groundingMetadata?.groundingChunks || []).filter(c => c.web?.uri).map(c => ({ url: c.web.uri, title: c.web.title })); }
    if (!text) throw new HttpError(503, 'El proveedor no devolvió una respuesta.');
    return { text, citations: citations.filter(c => /^https?:\/\//i.test(c.url)).slice(0, 12) };
}
