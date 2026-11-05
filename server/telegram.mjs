import { timingSafeEqual } from 'node:crypto';
import { digest, HttpError, newToken } from './security.mjs';
import { telegramCommand } from './telegram-commands.mjs';

const MENU = { keyboard: [[{ text: '💼 Mi cartera' }], [{ text: '💳 Wallets' }, { text: '🔔 Alertas' }], [{ text: '🌐 Abrir Alza' }, { text: '🛟 Ayuda' }]], resize_keyboard: true, is_persistent: true };
const menuCommands = { '💼 Mi cartera': '/cartera', '💳 Wallets': '/wallets', '🔔 Alertas': '/alertas', '🌐 Abrir Alza': '/alza', '🛟 Ayuda': '/ayuda' };
function appLinks(env, command, argument) {
    let origin; try { const url = new URL(env.APP_ORIGIN || 'https://activos-nu.vercel.app'); if (url.protocol === 'https:') origin = url.origin; } catch { /* No safe application URL. */ }
    if (!origin) return undefined;
    const price = new URL('/precios', origin);
    if (['activo', 'precio'].includes(command) && argument && !/^distribuci[oó]n$/i.test(argument)) price.searchParams.set('activo', argument);
    return { inline_keyboard: [[{ text: '💼 Mi cartera', url: `${origin}/mis-inversiones` }, { text: '💱 Precios', url: price.toString() }], [{ text: '🔔 Alertas', url: `${origin}/precios#alertas` }]] };
}

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

export async function telegramWebhook(db, env, header, body, now = Date.now(), { commandReply = telegramCommand, send = sendTelegram, clear = clearTelegramMessages } = {}) {
    const settings = config(env), expected = Buffer.from(settings.secret), actual = Buffer.from(typeof header === 'string' ? header : '');
    if (!settings.configured || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new HttpError(403, 'Solicitud no autorizada.');
    const message = body?.message, chat = message?.chat, text = typeof message?.text === 'string' ? message.text.trim() : '';
    if (chat?.type !== 'private' || !Number.isSafeInteger(chat.id) || chat.id <= 0 || message.from?.id !== chat.id) return { ok: true };
    const match = text.match(/^\/start ([\w-]{43})$/);
    if (match) {
        const code = await db.collection('telegram_link_codes').findOneAndDelete({ _id: digest(match[1]), expiresAt: { $gt: new Date(now) } });
        if (!code) return { ok: true };
        await db.collection('telegram_subscriptions').updateOne({ _id: code.userId }, { $set: { userId: code.userId, chatId: String(chat.id), updatedAt: new Date(now) } }, { upsert: true });
        await send(db, { chatId: String(chat.id) }, { title: 'Alza', body: 'Tu cuenta está conectada. Elegí una opción del menú o escribí /ayuda.', replyMarkup: MENU }, env);
        return { ok: true };
    }
    const input = menuCommands[text] || text;
    const command = input.match(/^\/(start|menu|alza|clear|cartera|activos|activo|distribucion|dividendos|alertas|dolar|ayuda|wallets|precio)(?:@[A-Za-z0-9_]+)?(?:\s+(.{1,150}))?$/i);
    if (!command) return { ok: true };
    const rows = await db.collection('telegram_subscriptions').find({ chatId: String(chat.id) }).limit(2).toArray();
    if (rows.length !== 1) {
        await send(db, { chatId: String(chat.id) }, { title: 'Alza', body: rows.length ? 'Este chat está vinculado a más de una cuenta. Desconectalo de las demás desde Alza para poder consultar la cartera.' : 'Vinculá primero tu cuenta desde Alza → Configuración → Notificaciones → Telegram.' }, env);
        return { ok: true };
    }
    const user = await db.collection('users').findOne({ _id: rows[0].userId, disabled: { $ne: true } }, { projection: { _id: 1 } });
    if (!user) return { ok: true };
    const action = command[1].toLowerCase(), argument = command[2] || '';
    if (action === 'clear') {
        if (Number.isSafeInteger(message.message_id) && message.message_id > 0) await clear(chat.id, message.message_id, env);
        return { ok: true };
    }
    if (action === 'start' || action === 'menu') { await send(db, rows[0], { title: 'Alza', body: 'Elegí una opción del menú o escribí /ayuda.', replyMarkup: MENU }, env); return { ok: true }; }
    if (action === 'alza') { await send(db, rows[0], { title: 'Alza', body: 'Abrí la sección que quieras:', replyMarkup: appLinks(env, action, argument) }, env); return { ok: true }; }
    if (action === 'precio') { await send(db, rows[0], { title: 'Alza', body: 'Consultá la evolución de precios en la página de Alza.', replyMarkup: appLinks(env, action, argument) }, env); return { ok: true }; }
    const reply = await commandReply(db, user._id, command[1].toLowerCase(), command[2] || '', env, { now });
    let chunk = '';
    for (const line of String(reply).split('\n')) {
        if (chunk.length + line.length + 1 > 3500 && chunk) { await send(db, rows[0], { title: 'Alza', body: chunk }, env); chunk = ''; }
        chunk += `${chunk ? '\n' : ''}${line.slice(0, 3400)}`;
    }
    if (chunk) await send(db, rows[0], { title: 'Alza', body: chunk, replyMarkup: appLinks(env, action, argument) }, env);
    return { ok: true };
}

export async function clearTelegramMessages(chatId, messageId, env, fetcher = fetch) {
    // Telegram does not expose chat history, so inspect a bounded window of recent IDs.
    const first = Math.max(1, messageId - 999);
    let succeeded = false, lastError;
    for (let end = messageId; end >= first; end -= 100) {
        const start = Math.max(first, end - 99);
        const messageIds = Array.from({ length: end - start + 1 }, (_, index) => start + index);
        try { await telegramCall(env, 'deleteMessages', { chat_id: chatId, message_ids: messageIds }, fetcher); succeeded = true; }
        catch (error) { lastError = error; }
    }
    if (!succeeded) throw lastError;
}

export async function telegramDisconnect(db, user) {
    await db.collection('telegram_link_codes').deleteMany({ userId: user._id });
    await db.collection('telegram_subscriptions').deleteOne({ _id: user._id });
    return { ok: true };
}

export async function sendTelegram(db, row, payload, env, fetcher = fetch) {
    if (!row.chatId || !/^\d+$/.test(row.chatId)) throw new HttpError(400, 'Destino de Telegram inválido.');
    await telegramCall(env, 'sendMessage', { chat_id: row.chatId, text: `${payload.title}\n${payload.body}`, link_preview_options: { is_disabled: true }, ...(payload.replyMarkup ? { reply_markup: payload.replyMarkup } : {}) }, fetcher);
    return true;
}

export async function telegramTest(db, user, env, payload = { title: '🧪 Alza · Prueba de notificación', body: 'Tu cuenta de Telegram está conectada.' }) {
    const row = await db.collection('telegram_subscriptions').findOne({ _id: user._id });
    if (!row) throw new HttpError(404, 'Conectá Telegram primero.');
    await sendTelegram(db, row, payload, env);
    return { ok: true };
}
