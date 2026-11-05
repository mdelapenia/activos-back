import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telegramCommand } from '../server/telegram-commands.mjs';
import { telegramWebhook } from '../server/telegram.mjs';

const env = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_BOT_USERNAME: 'example_bot', TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(40), TELEGRAM_WEBHOOK_URL: 'https://example.com/api/telegram/webhook', MASSIVE_API_KEY: 'test' };
const portfolio = { preferences: { display: 'USD' }, investments: [{ id: '1', name: 'Solana', kind: 'crypto', coin: 'solana', units: 2, amount: 100, currency: 'USD', date: '2026-01-01' }, { id: '2', name: 'Bitcoin', kind: 'crypto', coin: 'bitcoin', units: 1, amount: 0, costUnknown: true, currency: 'USD', date: '2026-01-01' }], alerts: [{ assetName: 'Solana', kind: 'price', threshold: 100, direction: 'above', channels: 'telegram' }] };
const db = { collection: () => ({ findOne: async ({ _id }) => _id === 'alice' ? { portfolio } : null }) };
const deps = { now: Date.parse('2026-11-05T15:00:00Z'), quotes: async () => ({ 'crypto:solana': 100, 'crypto:bitcoin': 300 }), stocks: async () => ({}), fx: async () => ({ value: 1000, source: 'USDC/ARS' }) };

test('cartera indica valor total y no inventa rendimiento con costos desconocidos', async () => {
    const response = await telegramCommand(db, 'alice', 'cartera', '', env, deps);
    assert.match(response, /500/); assert.match(response, /costo desconocido/); assert.match(response, /Resultado: No disponible/);
});
test('detalle identifica alias y muestra precio y rendimiento de la posición', async () => {
    const response = await telegramCommand(db, 'alice', 'activo', 'SOL', env, deps);
    assert.match(response, /Solana/); assert.match(response, /Cantidad: 2/); assert.match(response, /100%/); assert.doesNotMatch(response, /Bitcoin/);
});
test('no reemplaza cotizaciones faltantes por el costo', async () => {
    const response = await telegramCommand(db, 'alice', 'activos', '', env, { ...deps, quotes: async () => ({}) });
    assert.match(response, /Valor actual: No disponible/); assert.match(response, /Resultado: No disponible/);
});
test('alertas y dividendos muestran datos de la cuenta', async () => {
    const alerts = await telegramCommand(db, 'alice', 'alertas', '', env, deps);
    assert.match(alerts, /Solana/); assert.match(alerts, /Telegram/);
    const response = await telegramCommand(db, 'alice', 'dividendos', '', env, { ...deps, dividends: async () => ({ configured: true, items: [{ status: 'ok', ticker: 'AAPL', events: [{ payDate: '2026-11-10', eligible: true, estimatedGross: 1, estimated: true }] }] }) });
    assert.match(response, /AAPL/); assert.match(response, /estimado/);
});
test('distribución, dólares y ayuda muestran la información solicitada', async () => {
    assert.match(await telegramCommand(db, 'alice', 'distribucion', '', env, deps), /Cripto:.*500/);
    const fetcher = async () => ({ ok: true, json: async () => [{ casa: 'bolsa', nombre: 'MEP', compra: 990, venta: 1000 }] });
    assert.match(await telegramCommand(db, 'alice', 'dolar', '', env, { ...deps, fetcher }), /MEP.*1\.000/);
    assert.match(await telegramCommand(db, 'alice', 'ayuda', '', env, deps), /\/activo SOL/);
});
test('wallets consulta solo las direcciones del usuario y muestra fallos por red', async () => {
    const seen = [];
    const opts = { ...deps, wallets: async (_db, user) => { assert.equal(user._id, 'alice'); return { wallets: [{ id: 'one', label: 'Principal', network: 'solana', address: 'Abc123' }, { id: 'two', label: '', network: 'base', address: '0x123' }] }; }, holdings: async (_db, user, id) => { assert.equal(user._id, 'alice'); seen.push(id); if (id === 'two') throw new Error('no disponible'); return { holdings: [{ key: 'native', name: 'Solana', symbol: 'SOL', units: 2 }] }; } };
    const result = await telegramCommand(db, 'alice', 'wallets', '', env, opts);
    assert.deepEqual(seen, ['one', 'two']); assert.match(result, /Principal/); assert.match(result, /SOL.*2/); assert.match(result, /No se pudo consultar/);
});
test('webhook solo consulta la cuenta del chat privado y rechaza chats ambiguos', async () => {
    let subscriptions = [{ userId: 'alice', chatId: '123' }]; const calls = [], messages = [];
    const database = { collection: name => name === 'telegram_subscriptions' ? { find: filter => { assert.equal(filter.chatId, '123'); return { limit: () => ({ toArray: async () => subscriptions }) }; } } : { findOne: async filter => ({ _id: filter._id }) } };
    const body = { message: { chat: { id: 123, type: 'private' }, from: { id: 123 }, text: '/cartera' } };
    const opts = { commandReply: async (_db, userId) => { calls.push(userId); return 'resultado'; }, send: async (_db, row, payload) => { messages.push({ row, payload }); } };
    await telegramWebhook(database, env, env.TELEGRAM_WEBHOOK_SECRET, body, Date.now(), opts);
    assert.deepEqual(calls, ['alice']); assert.equal(messages[0].payload.body, 'resultado');
    subscriptions = [{ userId: 'alice', chatId: '123' }, { userId: 'bob', chatId: '123' }];
    await telegramWebhook(database, env, env.TELEGRAM_WEBHOOK_SECRET, body, Date.now(), opts);
    assert.deepEqual(calls, ['alice']); assert.match(messages[1].payload.body, /más de una cuenta/);
    await telegramWebhook(database, env, env.TELEGRAM_WEBHOOK_SECRET, { message: { ...body.message, chat: { id: 123, type: 'group' } } }, Date.now(), opts);
    assert.equal(messages.length, 2);
});
