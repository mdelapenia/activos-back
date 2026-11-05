import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearTelegramMessages, telegramWebhook } from '../server/telegram.mjs';

const env = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_BOT_USERNAME: 'example_bot', TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(40), TELEGRAM_WEBHOOK_URL: 'https://example.com/api/telegram/webhook' };

test('/clear intenta borrar hasta 1000 identificadores en lotes de 100', async () => {
    const requests = [];
    await clearTelegramMessages(123, 1150, env, async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ ok: true, result: true }) }; });
    assert.equal(requests.length, 10);
    assert.match(requests[0].url, /\/deleteMessages$/);
    assert.equal(requests[0].body.chat_id, 123);
    assert.equal(requests[0].body.message_ids.length, 100);
    assert.equal(requests[0].body.message_ids.at(-1), 1150);
    assert.equal(requests.at(-1).body.message_ids[0], 151);
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
