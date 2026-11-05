import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telegramConnect, telegramWebhook, telegramDisconnect, sendTelegram } from '../server/telegram.mjs';
import { digest } from '../server/security.mjs';
import { alertTestPayload, checkPricePush, checkDividendPush } from '../server/push.mjs';

const env = { TELEGRAM_BOT_TOKEN: '12345:abc_DEF', TELEGRAM_BOT_USERNAME: 'example_bot', TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(40), TELEGRAM_WEBHOOK_URL: 'https://example.com/api/telegram/webhook' };
test('vincula un chat privado con código de un solo uso y permite desconectarlo', async () => {
    let code, subscription, webhookRequest;
    const db = { collection: name => name === 'telegram_link_codes' ? {
        deleteMany: async () => { code = null; }, insertOne: async row => { code = row; },
        findOneAndDelete: async filter => { if (!code || code._id !== filter._id || code.expiresAt <= filter.expiresAt.$gt) return null; const result = code; code = null; return result; },
    } : { updateOne: async (filter, update) => { subscription = { _id: filter._id, ...update.$set }; }, deleteOne: async filter => { if (subscription?._id === filter._id) subscription = null; } } };
    const fetcher = async (url, options) => { webhookRequest = { url, body: JSON.parse(options.body) }; return { ok: true, json: async () => ({ ok: true, result: true }) }; };
    const { url } = await telegramConnect(db, { _id: 'alice' }, env, 1000, fetcher);
    const token = new URL(url).searchParams.get('start');
    assert.equal(code._id, digest(token)); assert.equal(webhookRequest.body.secret_token, env.TELEGRAM_WEBHOOK_SECRET);
    const update = { message: { chat: { id: 123, type: 'private' }, from: { id: 123 }, text: `/start ${token}` } };
    await assert.rejects(telegramWebhook(db, env, 'incorrecto', update, 2000), { status: 403 });
    await telegramWebhook(db, env, env.TELEGRAM_WEBHOOK_SECRET, { message: { ...update.message, chat: { id: 123, type: 'group' } } }, 2000);
    assert.equal(subscription, undefined);
    await telegramWebhook(db, env, env.TELEGRAM_WEBHOOK_SECRET, update, 2000);
    assert.equal(subscription.chatId, '123'); assert.equal(subscription.userId, 'alice');
    await telegramWebhook(db, env, env.TELEGRAM_WEBHOOK_SECRET, { message: { ...update.message, chat: { id: 999, type: 'private' }, from: { id: 999 } } }, 2000);
    assert.equal(subscription.chatId, '123');
    await telegramDisconnect(db, { _id: 'alice' }); assert.equal(subscription, null);
});

test('avisa por Telegram sin suscripción push y evita duplicados', async () => {
    const sent = [], deliveries = new Set();
    const alert = { id: 'alerta', kind: 'price', assetKind: 'crypto', assetId: 'solana', assetName: 'Solana', threshold: 100, direction: 'above' };
    const db = { collection(name) {
        if (name === 'push_subscriptions') return { find: () => ({ toArray: async () => [] }) };
        if (name === 'telegram_subscriptions') return { find: () => ({ toArray: async () => [{ _id: 'alice', userId: 'alice', chatId: '123' }] }) };
        if (name === 'portfolios') return { findOne: async () => ({ portfolio: { alerts: [alert], investments: [], preferences: {} } }) };
        if (name === 'push_deliveries') return { insertOne: async row => { if (deliveries.has(row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 }); deliveries.add(row._id); }, deleteOne: async row => deliveries.delete(row._id) };
        throw new Error(name);
    } };
    const options = { loadQuotes: async () => ({ 'crypto:solana': 120 }), deliver: async (_db, row, payload) => { sent.push({ row, payload }); } };
    await checkPricePush(db, env, Date.parse('2026-11-05T15:00:00Z'), options);
    await checkPricePush(db, env, Date.parse('2026-11-05T15:00:00Z'), options);
    assert.equal(sent.length, 1); assert.equal(sent[0].row.channel, 'telegram'); assert.match(sent[0].payload.body, /100/);
});

test('envía el mismo título y texto al chat vinculado', async () => {
    let body;
    const fetcher = async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ ok: true }) }; };
    await sendTelegram({}, { chatId: '123' }, { title: 'Aviso', body: 'Detalle' }, env, fetcher);
    assert.deepEqual(body, { chat_id: '123', text: 'Aviso\nDetalle', link_preview_options: { is_disabled: true } });
});

test('la prueba usa la alerta de la cuenta y el precio actual', async () => {
    const alert = { id: 'sol', kind: 'price', assetKind: 'crypto', assetId: 'solana', assetName: 'Solana', threshold: 100, direction: 'above' };
    const db = { collection: () => ({ findOne: async filter => filter._id === 'alice' ? { portfolio: { alerts: [alert] } } : null }) };
    const quotes = async () => ({ 'crypto:solana': 120 });
    const payload = await alertTestPayload(db, { _id: 'alice' }, env, 'sol', undefined, quotes);
    assert.match(payload.title, /Solana/); assert.match(payload.body, /120/); assert.match(payload.body, /100/);
    await assert.rejects(alertTestPayload(db, { _id: 'bob' }, env, 'sol', undefined, quotes), { status: 404 });
});

test('cada alerta se envía solo por el canal configurado', async () => {
    const sent = [], deliveries = new Set();
    const alerts = ['push', 'telegram', 'both'].map(channels => ({ id: channels, channels, kind: 'price', assetKind: 'crypto', assetId: 'solana', assetName: channels, threshold: 100, direction: 'above' }));
    const db = { collection(name) {
        if (name === 'push_subscriptions') return { find: () => ({ toArray: async () => [{ _id: 'device', userId: 'alice' }] }) };
        if (name === 'telegram_subscriptions') return { find: () => ({ toArray: async () => [{ _id: 'alice', userId: 'alice', chatId: '123' }] }) };
        if (name === 'portfolios') return { findOne: async () => ({ portfolio: { alerts, investments: [], preferences: {} } }) };
        if (name === 'push_deliveries') return { insertOne: async row => { deliveries.add(row._id); }, deleteOne: async row => deliveries.delete(row._id) };
        throw new Error(name);
    } };
    await checkPricePush(db, env, Date.parse('2026-11-05T15:00:00Z'), { loadQuotes: async () => ({ 'crypto:solana': 120 }), deliver: async (_db, row, payload) => sent.push(`${row.channel || 'push'}:${payload.title}`) });
    assert.equal(sent.length, 4);
    assert.ok(sent.some(value => value.startsWith('push:') && value.includes('push')));
    assert.ok(sent.some(value => value.startsWith('telegram:') && value.includes('telegram')));
    assert.equal(sent.filter(value => value.includes('both')).length, 2);
});

test('los avisos de dividendos eligen el umbral más cercano por canal', async () => {
    const sent = [];
    const alerts = [{ id: 'early', channels: 'push', threshold: 7 }, { id: 'late', channels: 'telegram', threshold: 3 }].map(a => ({ ...a, kind: 'dividend', assetKind: 'stock', assetId: 'AAPL', assetName: 'Apple' }));
    const db = { collection(name) {
        if (name === 'push_subscriptions') return { find: () => ({ toArray: async () => [{ _id: 'device', userId: 'alice' }] }) };
        if (name === 'telegram_subscriptions') return { find: () => ({ toArray: async () => [{ _id: 'alice', userId: 'alice', chatId: '123' }] }) };
        if (name === 'portfolios') return { findOne: async () => ({ portfolio: { alerts, investments: [], preferences: {} } }) };
        if (name === 'push_deliveries') return { insertOne: async () => {}, deleteOne: async () => {} };
        throw new Error(name);
    } };
    await checkDividendPush(db, { ...env, MASSIVE_API_KEY: 'test' }, Date.parse('2026-11-05T15:00:00Z'), { loadDividends: async () => ({ configured: true, items: [{ status: 'ok', kind: 'stock', ticker: 'AAPL', events: [{ payDate: '2026-11-07', eligible: true, estimatedGross: 1 }] }] }), deliver: async (_db, row) => sent.push(row.channel || 'push') });
    assert.deepEqual(sent.sort(), ['push', 'telegram']);
});
