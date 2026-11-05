import { timingSafeEqual } from 'node:crypto';
import { digest, HttpError, newToken } from './security.mjs';

function config(env) {
    const token = env.TELEGRAM_BOT_TOKEN || '', username = (env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''), secret = env.TELEGRAM_WEBHOOK_SECRET || '', webhook = env.TELEGRAM_WEBHOOK_URL || '';
    let url; try { url = new URL(webhook); } catch { /* missing configuration */ }
    return { token, username, secret, webhook, configured: /^\d+:[\w-]+$/.test(token) && /^[A-Za-z0-9_]{5,32}$/.test(username) && /^[A-Za-z0-9_-]{32,256}$/.test(secret) && url?.protocol === 'https:' && url.pathname === '/api/telegram/webhook' && !url.search && !url.hash };
}

async function telegramCall(env, method, body, fetcher = fetch) {
    const { token } = config(env);
    if (!token) throw new HttpError(503, 'Telegram todavía no está configurado.');
    let response, data;
    try { response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }); data = await response.json(); }
    catch { throw new HttpError(503, 'No se pudo conectar con Telegram.'); }
    if (!response.ok || !data?.ok) throw new HttpError(503, 'Telegram no pudo completar la operación.');
    return data.result;
}

export async function telegramStatus(db, user, env) {
    const configured = Boolean(config(env).configured);
    const row = await db.collection('telegram_subscriptions').findOne({ _id: user._id });
    return { configured, connected: !!row };
}

export async function telegramConnect(db, user, env, now = Date.now(), fetcher = fetch) {
    const settings = config(env);
    if (!settings.configured) throw new HttpError(503, 'Telegram todavía no está configurado en el servidor.');
    await telegramCall(env, 'setWebhook', { url: settings.webhook, secret_token: settings.secret, allowed_updates: ['message'] }, fetcher);
    const token = newToken();
    await db.collection('telegram_link_codes').deleteMany({ userId: user._id });
    await db.collection('telegram_link_codes').insertOne({ _id: digest(token), userId: user._id, expiresAt: new Date(now + 10 * 60_000) });
    return { url: `https://t.me/${settings.username}?start=${token}` };
}

export async function telegramWebhook(db, env, header, body, now = Date.now()) {
    const settings = config(env), expected = Buffer.from(settings.secret), actual = Buffer.from(typeof header === 'string' ? header : '');
    if (!settings.configured || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new HttpError(403, 'Solicitud no autorizada.');
    const message = body?.message, chat = message?.chat, match = typeof message?.text === 'string' && message.text.match(/^\/start ([\w-]{43})$/);
    if (chat?.type !== 'private' || !Number.isSafeInteger(chat.id) || chat.id <= 0 || message.from?.id !== chat.id || !match) return { ok: true };
    const code = await db.collection('telegram_link_codes').findOneAndDelete({ _id: digest(match[1]), expiresAt: { $gt: new Date(now) } });
    if (!code) return { ok: true };
    await db.collection('telegram_subscriptions').updateOne({ _id: code.userId }, { $set: { userId: code.userId, chatId: String(chat.id), updatedAt: new Date(now) } }, { upsert: true });
    return { ok: true };
}

export async function telegramDisconnect(db, user) {
    await db.collection('telegram_link_codes').deleteMany({ userId: user._id });
    await db.collection('telegram_subscriptions').deleteOne({ _id: user._id });
    return { ok: true };
}

export async function sendTelegram(db, row, payload, env, fetcher = fetch) {
    if (!row.chatId || !/^\d+$/.test(row.chatId)) throw new HttpError(400, 'Destino de Telegram inválido.');
    await telegramCall(env, 'sendMessage', { chat_id: row.chatId, text: `${payload.title}\n${payload.body}`, link_preview_options: { is_disabled: true } }, fetcher);
    return true;
}

export async function telegramTest(db, user, env, payload = { title: '🧪 Alza · Prueba de notificación', body: 'Tu cuenta de Telegram está conectada.' }) {
    const row = await db.collection('telegram_subscriptions').findOne({ _id: user._id });
    if (!row) throw new HttpError(404, 'Conectá Telegram primero.');
    await sendTelegram(db, row, payload, env);
    return { ok: true };
}
