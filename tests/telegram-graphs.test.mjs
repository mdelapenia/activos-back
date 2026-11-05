import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telegramWebhook } from '../server/telegram.mjs';

const env = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_BOT_USERNAME: 'example_bot', TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(40), TELEGRAM_WEBHOOK_URL: 'https://example.com/api/telegram/webhook', APP_ORIGIN: 'https://alza.example' };
test('los botones del menú solo ejecutan consultas del chat autenticado', async () => {
    const responses = [], calls = [];
    const database = { collection: name => name === 'telegram_subscriptions' ? { find: () => ({ limit: () => ({ toArray: async () => [{ userId: 'alice', chatId: '123' }] }) }) } : { findOne: async () => ({ _id: 'alice' }) } };
    const opts = { registerCommands: async () => {}, send: async (_db, row, payload) => responses.push({ row, payload }), commandReply: async (_db, user, command) => { calls.push({ user, command }); return 'Cartera'; } };
    const message = text => ({ message: { chat: { id: 123, type: 'private' }, from: { id: 123 }, text } });
    await telegramWebhook(database, env, env.TELEGRAM_WEBHOOK_SECRET, message('/start'), Date.now(), opts);
    assert.ok(responses[0].payload.replyMarkup.keyboard);
    assert.doesNotMatch(JSON.stringify(responses[0].payload.replyMarkup), /gráfico/i);
    await telegramWebhook(database, env, env.TELEGRAM_WEBHOOK_SECRET, message('💼 Mi cartera'), Date.now(), opts);
    assert.deepEqual(calls[0], { user: 'alice', command: 'cartera' });
    assert.match(responses[1].payload.replyMarkup.inline_keyboard[0][0].url, /mis-inversiones/);
    await telegramWebhook(database, env, env.TELEGRAM_WEBHOOK_SECRET, message('/grafico distribucion'), Date.now(), opts);
    await telegramWebhook(database, env, env.TELEGRAM_WEBHOOK_SECRET, message('/grafico SOL'), Date.now(), opts);
    assert.equal(calls.length, 1);
    assert.equal(responses.length, 2);
});
