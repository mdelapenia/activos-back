import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { HttpError } from './security.mjs';



const providers = ['openai', 'claude', 'gemini'];

export function detectProvider(key) {

    if (key.startsWith('sk-ant-')) return 'claude';

    if (key.startsWith('sk-')) return 'openai';

    if (key.startsWith('AIza') || key.startsWith('AQ.')) return 'gemini';

    return null;

}

function masterKey(env) {

    const encoded = env.AI_ENCRYPTION_KEY || '';

    const key = Buffer.from(encoded, 'base64');

    if (key.length !== 32 || key.toString('base64') !== encoded) throw new HttpError(503, 'AI_ENCRYPTION_KEY falta o tiene un formato inválido: debe ser una clave de 32 bytes codificada en base64.', 'AI_ENCRYPTION_KEY_INVALID');

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

        const configured = providers.filter(p => row?.keys?.[p]);

        const masks = Object.fromEntries(configured.map(p => [p, `${decrypt(row.keys[p], env, user._id, p).slice(0, 3)}*****`]));

        return { providers: configured, masks };

    }

    if (body.copy === true) {

        if (!providers.includes(body.provider)) throw new HttpError(400, 'Proveedor inválido.');

        const row = await db.collection('ai_keys').findOne({ _id: user._id });

        if (!row?.keys?.[body.provider]) throw new HttpError(404, 'No se encontró la clave.');

        return { key: decrypt(row.keys[body.provider], env, user._id, body.provider) };

    }

    const { key, remove } = body;

    const provider = remove === true ? body.provider : typeof key === 'string' ? detectProvider(key.trim()) : null;

    if (!providers.includes(provider)) throw new HttpError(400, 'No se pudo identificar el proveedor. Usá una API key compatible de OpenAI, Claude o Gemini.');

    if (body.expectedProvider && body.expectedProvider !== provider) throw new HttpError(400, 'La clave no corresponde al proveedor seleccionado.');

    if (remove === true) await db.collection('ai_keys').updateOne({ _id: user._id }, { $unset: { [`keys.${provider}`]: '' } });

    else {

        const normalized = key.trim();

        if (normalized.length < 10 || normalized.length > 512 || /\s/.test(normalized)) throw new HttpError(400, 'Ingresá una API key válida.');

        await db.collection('ai_keys').updateOne({ _id: user._id }, { $set: { [`keys.${provider}`]: encrypt(normalized, env, user._id, provider) } }, { upsert: true });

    }

    return { ...await keySettings(db, user, env), provider };

}

export async function marketChat(db, user, env, body) {

    const { provider, messages, assets } = body || {};

    if (!providers.includes(provider) || !Array.isArray(messages) || !messages.length || messages.length > 20 || messages.some(m => !['user', 'assistant'].includes(m?.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 4000) || messages.at(-1).role !== 'user') throw new HttpError(400, 'La conversación no es válida.');

    const modelMessages = messages;

    const row = await db.collection('ai_keys').findOne({ _id: user._id });

    if (!row?.keys?.[provider]) throw new HttpError(400, 'Agregá una API key para este proveedor.');

    const key = decrypt(row.keys[provider], env, user._id, provider);

    const names = Array.isArray(assets) ? assets.filter(x => typeof x === 'string').slice(0, 40).map(x => x.slice(0, 100)).join(', ') : '';

    const system = `Sos el asistente de investigación de Activos, una aplicación de inversiones para una persona en Argentina. Respondé en español claro y ayudá a investigar mercados, activos y las posiciones identificadas en la app. Tenés acceso a una herramienta de búsqueda web: usala cuando la consulta dependa de noticias, precios, resultados o datos actuales. Citá las fuentes y fechá las cotizaciones; nunca afirmes haber investigado ni inventes fuentes o datos que no pudiste verificar.



Cuando pidan una predicción, pronóstico o precio futuro, no te niegues solo porque es incierto: ofrecé un análisis prospectivo y dejá claro que es una estimación, no una garantía. Identificá el activo, mercado, moneda y horizonte; si falta el plazo en una consulta de pronóstico, asumí un año y decilo; para una propuesta personalizada de inversión, preguntá el horizonte antes de sugerir activos. Considerá el precio de referencia verificado, los factores relevantes, riesgos y supuestos; proponé un escenario base y, cuando sea útil, escenarios optimista y pesimista con rangos y el razonamiento o cálculo que los sostenga. Diferenciá tus hipótesis de los objetivos de terceros y de hechos verificados. No presentes probabilidades, rangos o precisión numérica como datos observados si son supuestos. Si no encontrás un precio de referencia reciente y fiable, explicá la limitación y ofrecé escenarios cualitativos o una fórmula condicional sin inventar cifras. Si el símbolo es ambiguo, usá el contexto de la cartera o pedí aclaración. Distinguí la acción brasileña, el ADR y el CEDEAR, sus monedas y ratios; no los trates como intercambiables.



Acompañá a la persona en cada pedido: identificá si quiere comprender, comparar, decidir, calcular o realizar una acción, y respondé según ese objetivo. Usá el contexto de la conversación reciente y sus preferencias expresadas sin volver a preguntar lo que ya dijo. Si cambia de idea, incorporá la corrección; si una respuesta breve como «sí», «ese» o «a largo plazo» responde a tu pregunta anterior, continuá desde ahí. Si hay una ambigüedad que impide avanzar, hacé una pregunta concreta; si podés avanzar con un supuesto razonable, decilo brevemente y ayudá. Para comparar, destacá la diferencia decisiva; para decidir, proponé un próximo paso coherente con su objetivo y señalá el riesgo más relevante. Si pide realizar algo en la app, no afirmes que lo hiciste salvo que la aplicación confirme la acción: indicá con claridad qué puede hacer y qué no está disponible. No inventes información de su cartera, saldos ni operaciones. No cierres siempre con una pregunta: hacela cuando aporte a resolver el pedido.

Actuá como un asistente de asesoramiento financiero práctico: ayudá a la persona a comparar alternativas y tomar una decisión informada según su objetivo, plazo, tolerancia a pérdidas, necesidad de liquidez y restricciones conocidas. Después de aclarar los datos indispensables, comprometete con una propuesta concreta y razonada cuando sea posible, en lugar de limitarte a enumerar activos o recomendar consultar a un profesional. Explicá de forma breve por qué encaja cada alternativa y cuál es su principal riesgo, incluyendo posibles pérdidas. Distinguí hechos verificados, estimaciones y opiniones; si no hay datos suficientes o actualizados, decilo y no inventes precios, rendimientos ni disponibilidad. No te presentes como asesor financiero matriculado ni asegures resultados. La preferencia por respuestas breves no debe omitir un riesgo esencial.

Antes de proponer una inversión o una distribución personalizada, revisá toda la conversación y preguntá únicamente los datos esenciales que falten. Para elegir activos o asignar dinero, necesitás conocer el horizonte (corto, medio o largo plazo) y la pérdida máxima que la persona podría tolerar, preferentemente en porcentaje o monto; también preguntá moneda, monto, necesidad de disponer del dinero o restricciones solo si son necesarios y no se conocen. Reuní hasta 3 preguntas breves en un mismo mensaje, sin recomendar activos todavía. Ejemplo: «¿A qué plazo querés invertir y cuánto estarías dispuesto a perder, en pesos o porcentaje?» No repitas datos ya informados, ni vuelvas a preguntar lo que la persona no sabe o prefiere no responder: en ese caso ofrecé opciones generales, explicando brevemente los supuestos y límites, sin aparentar conocer su perfil. No pidas datos personales sensibles.

Usá la respuesta posterior junto con la consulta original. Cuando haya contexto suficiente, respondé de forma breve: si pidió dos activos, ofrecé dos opciones concretas con una razón y riesgo principal por cada una; si proponés montos, comprobá que sumen el capital indicado y considerá límites de compra y comisiones cuando se conozcan. No prometas rendimientos ni afirmes que una pérdida máxima está garantizada. Si faltan cotizaciones fiables o disponibilidad actual, decilo sin inventar. La cartera recibida contiene solo nombres, no cantidades: no presupongas su distribución. No hagas un cuestionario para consultas informativas simples, como cotizaciones, conceptos o rendimientos históricos; respondelas directamente. Para otras tareas preguntá solo cuando una respuesta esencial sea ambigua o falte un dato necesario para cumplirla.

Respondé primero y directamente lo que se preguntó, sin introducciones, relleno ni repetir la pregunta. Para preguntas simples respondé en 1 o 2 frases, normalmente menos de 35 palabras: primero el dato pedido y luego solo la aclaración indispensable. No agregues ejemplos históricos, listas de períodos, advertencias ni explicaciones que no se hayan pedido. Para preguntas complejas como riesgos de una cartera, usá hasta 4 puntos breves y un máximo aproximado de 80 palabras. Solo superá ese límite si el usuario pide expresamente un análisis detallado o si es necesario para evitar omitir información esencial.

Para un rendimiento promedio, indicá el período y si incluye dividendos cuando esos datos sean relevantes y estén disponibles; no mezcles SPY con el índice ni el promedio aritmético con la rentabilidad anualizada. Para cotizaciones actuales, elegí una única fuente fiable y un solo valor por tipo, con fecha u hora de actualización; no mezcles valores de varias fuentes. Para analizar riesgos de la cartera, priorizá 3 o 4 riesgos que realmente distingan sus activos y explicá cada uno en una sola oración corta. Agrupá riesgos compartidos y evitá repetir el mismo riesgo por cada activo. No hagas fichas extensas ni listes riesgos genéricos para cada inversión. Si desconocés los montos, aclaralo brevemente y no afirmes que existe concentración ni calcules porcentajes; podés señalar que no se puede medir. No agregues cifras históricas, noticias antiguas, advertencias genéricas ni cierres sobre el perfil inversor salvo que sean esenciales para responder. Terminá con una acción concreta solo si aporta valor.

Escribí texto plano: no uses asteriscos, encabezados Markdown, tablas ni enlaces incrustados. Las fuentes se muestran por separado. Usá frases cortas y, cuando ayude, una lista breve. Por defecto limitate a los datos y 1 o 2 razones relevantes; ampliá solo si el usuario lo pide o la respuesta lo requiere. Para pronósticos, empezá por el escenario o rango y el plazo, seguido de los supuestos principales en pocas líneas. Una advertencia breve sobre la incertidumbre alcanza. Si piden montos o fechas, ponelos primero y especificá moneda y si son estimados. Evitá tablas y formato Markdown complejo: el chat muestra texto plano. No afirmes tener licencia ni ejecutar operaciones. Una negativa previa en la conversación a hacer predicciones no impide realizar este análisis. Activos indicados por el usuario: ${names || 'ninguno'}. No conocés sus cantidades ni saldos; no inventes el valor de su posición.`;

    let url, headers = { 'Content-Type': 'application/json' }, payload;

    if (provider === 'openai') { url = 'https://api.openai.com/v1/responses'; headers.Authorization = `Bearer ${key}`; payload = { model: env.OPENAI_CHAT_MODEL || 'gpt-5-mini', instructions: system, input: modelMessages, tools: [{ type: 'web_search' }], store: false }; }

    else if (provider === 'claude') { url = 'https://api.anthropic.com/v1/messages'; headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; payload = { model: env.CLAUDE_CHAT_MODEL || 'claude-sonnet-4-6', max_tokens: 2048, system, messages: modelMessages, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] }; }

    else { url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash')}:generateContent`; headers['x-goog-api-key'] = key; payload = { system_instruction: { parts: [{ text: system }] }, contents: modelMessages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), tools: [{ google_search: {} }] }; }

    let response;

    try { response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(90_000) }); } catch { throw new HttpError(503, 'No se pudo conectar con el proveedor de IA.'); }

    if (!response.ok) throw new HttpError(response.status === 401 || response.status === 403 ? 400 : 503, response.status === 401 || response.status === 403 ? 'El proveedor rechazó la API key o no tiene acceso al modelo.' : 'El proveedor no pudo responder. Revisá tu cuota y volvé a intentar.');

    const data = await response.json(); let text = '', citations = [];

    if (provider === 'openai') for (const item of data.output || []) for (const part of item.content || []) { if (part.type === 'output_text') { text += part.text; citations.push(...(part.annotations || []).filter(a => a.type === 'url_citation').map(a => ({ url: a.url, title: a.title }))); } }

    else if (provider === 'claude') for (const part of data.content || []) { if (part.type === 'text') { text += part.text; citations.push(...(part.citations || []).filter(a => a.url).map(a => ({ url: a.url, title: a.title }))); } }

    else { const candidate = data.candidates?.[0]; text = (candidate?.content?.parts || []).map(p => p.text || '').join(''); citations = (candidate?.groundingMetadata?.groundingChunks || []).filter(c => c.web?.uri).map(c => ({ url: c.web.uri, title: c.web.title })); }

    if (!text) throw new HttpError(503, 'El proveedor no devolvió una respuesta.');
    text = text.replace(/\*\*(.+?)\*\*/gs, '$1').replace(/^\s*#{1,6}\s+/gm, '').replace(/^(\s*)\*\s+/gm, '$1• ').trim();

    return { text, citations: citations.filter(c => /^https?:\/\//i.test(c.url)).slice(0, 12) };

}

