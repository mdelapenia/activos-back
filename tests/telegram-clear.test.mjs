import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearTelegramMessages, telegramWebhook } from '../server/telegram.mjs';

const env = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_BOT_USERNAME: 'example_bot', TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(40), TELEGRAM_WEBHOOK_URL: 'https://example.com/api/telegram/webhook' };

test('/clear elimina como máximo 100 identificadores recientes, incluido el comando', async () => {
    let request;
    await clearTelegramMessages(123, 150, env, async (url, options) => { request = { url, body: JSON.parse(options.body) }; return { ok: true, json: async () => ({ ok: true, result: true }) }; });
    assert.match(request.url, /\/deleteMessages$/);
    assert.equal(request.body.chat_id, 123);
    assert.equal(request.body.message_ids.length, 100);
    assert.equal(request.body.message_ids[0], 51);
    assert.equal(request.body.message_ids.at(-1), 150);
});

test('/clear solo actúa en el chat privado vinculado', async () => {
    const calls = [];
    const db = { collection: name => name === 'telegram_subscriptions' ? { find: () => ({ limit: () => ({ toArray: async () => [{ userId: 'alice', chatId: '123' }] }) }) } : { findOne: async () => ({ _id: 'alice' }) } };
    const options = { clear: async (...args) => calls.push(args) };
    const message = { chat: { id: 123, type: 'private' }, from: { id: 123 }, message_id: 12, text: '/clear' };
    await telegramWebhook(db, env, env.TELEGRAM_WEBHOOK_SECRET, { message }, Date.now(), options);
    assert.deepEqual(calls, [[123, 12, env]]);
    await telegramWebhook(db, env, env.TELEGRAM_WEBHOOK_SECRET, { message: { ...message, chat: { id: 123, type: 'group' } } }, Date.now(), options);
    assert.equal(calls.length, 1);
});
