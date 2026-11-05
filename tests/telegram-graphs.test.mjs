import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telegramGraph } from '../server/telegram-graphs.mjs';
import { telegramWebhook, sendTelegramPhoto } from '../server/telegram.mjs';

const env = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_BOT_USERNAME: 'example_bot', TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(40), TELEGRAM_WEBHOOK_URL: 'https://example.com/api/telegram/webhook', APP_ORIGIN: 'https://alza.example' };
const portfolio = { investments: [{ id: '1', name: 'Solana', kind: 'crypto', coin: 'solana', currency: 'USD', units: 2 }], preferences: { display: 'USD' } };
const db = { collection: () => ({ findOne: async () => ({ portfolio }) }) };
const png = value => assert.deepEqual([...value.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

test('genera un PNG de distribución e indica si faltan cotizaciones', async () => {
    const positions = async () => ({ rows: [{ kind: 'crypto', currency: 'USD', value: 200 }], fx: null });
    const result = await telegramGraph(db, 'alice', 'distribucion', { positions }); png(result.png);
    const missing = await telegramGraph(db, 'alice', 'distribucion', { positions: async () => ({ rows: [{ kind: 'crypto', currency: 'USD', value: NaN }], fx: null }) });
    assert.match(missing.error, /faltan cotizaciones/);
});
test('genera un PNG histórico con precios reales y rechaza un historial insuficiente', async () => {
    const now = Date.parse('2026-11-05T15:00:00Z');
    const fetcher = async () => ({ ok: true, json: async () => ({ prices: [[now - 86400000, 100], [now - 1000, 110]] }) });
    const result = await telegramGraph(db, 'alice', 'SOL', { now, fetcher }); png(result.png); assert.match(result.caption, /Solana/);
    const missing = await telegramGraph(db, 'alice', 'SOL', { now, fetcher: async () => ({ ok: true, json: async () => ({ prices: [] }) }) });
    assert.match(missing.error, /suficientes datos/);
});
test('los botones del menú solo ejecutan consultas del chat autenticado', async () => {
    const responses = [], calls = [];
    const database = { collection: name => name === 'telegram_subscriptions' ? { find: () => ({ limit: () => ({ toArray: async () => [{ userId: 'alice', chatId: '123' }] }) }) } : { findOne: async () => ({ _id: 'alice' }) } };
    const opts = { send: async (_db, row, payload) => responses.push({ row, payload }), commandReply: async (_db, user, command) => { calls.push({ user, command }); return 'Cartera'; }, graph: async (_db, user, argument) => { calls.push({ user, argument }); return { png: Buffer.from('png'), caption: 'Gráfico' }; }, sendPhoto: async (row, image) => responses.push({ row, image }) };
    const message = text => ({ message: { chat: { id: 123, type: 'private' }, from: { id: 123 }, text } });
    await telegramWebhook(database, env, env.TELEGRAM_WEBHOOK_SECRET, message('/start'), Date.now(), opts);
    assert.ok(responses[0].payload.replyMarkup.keyboard);
    await telegramWebhook(database, env, env.TELEGRAM_WEBHOOK_SECRET, message('💼 Mi cartera'), Date.now(), opts);
    assert.deepEqual(calls[0], { user: 'alice', command: 'cartera' });
    assert.match(responses[1].payload.replyMarkup.inline_keyboard[0][0].url, /mis-inversiones/);
    await telegramWebhook(database, env, env.TELEGRAM_WEBHOOK_SECRET, message('📊 Gráfico de distribución'), Date.now(), opts);
    assert.deepEqual(calls[1], { user: 'alice', argument: 'distribucion' }); assert.equal(responses[2].image.toString(), 'png');
});
test('el envío del gráfico adjunta PNG sin exponerlo a un proveedor de gráficos', async () => {
    let captured;
    await sendTelegramPhoto({ chatId: '123' }, Buffer.from('png'), 'Detalle', env, async (url, options) => { captured = { url, options }; return { ok: true, json: async () => ({ ok: true }) }; });
    assert.match(captured.url, /^https:\/\/api\.telegram\.org\//); assert.equal(captured.options.body.get('chat_id'), '123'); assert.equal(captured.options.body.get('photo').type, 'image/png');
});
