import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarySettings, summarySlot, buildSummary, checkScheduledSummaries } from '../server/scheduled-summary.mjs';

test('calcula el período diario y semanal en horario argentino', () => {
    const daily = { frequency: 'daily', time: '09:00', day: 1 };
    assert.equal(summarySlot(daily, Date.parse('2026-11-05T11:59:00Z')).slot, '2026-11-04');
    assert.equal(summarySlot(daily, Date.parse('2026-11-05T12:00:00Z')).slot, '2026-11-05');
    const weekly = { frequency: 'weekly', time: '09:00', day: 1 };
    assert.equal(summarySlot(weekly, Date.parse('2026-11-05T15:00:00Z')).slot, '2026-11-02');
    assert.equal(summarySlot(weekly, Date.parse('2026-11-02T11:59:00Z')).slot, '2026-10-26');
});

test('valida y guarda opciones de resumen por usuario', async () => {
    let saved;
    const db = { collection: () => ({ updateOne: async (filter, update) => { saved = { _id: filter._id, ...update.$set }; }, findOne: async () => saved }) };
    const settings = { enabled: true, frequency: 'weekly', time: '10:15', day: 5, channels: 'telegram' };
    await summarySettings(db, { _id: 'alice' }, settings, 1000);
    assert.equal(saved._id, 'alice'); assert.equal(saved.enabledAt.getTime(), 1000);
    assert.deepEqual((await summarySettings(db, { _id: 'alice' }, null)).settings, settings);
    await assert.rejects(summarySettings(db, { _id: 'alice' }, { ...settings, day: 9 }), { status: 400 });
});

test('un resumen informa datos faltantes y no inventa valores', async () => {
    const portfolio = { investments: [{ kind: 'crypto' }], preferences: { display: 'USD' } };
    const result = await buildSummary(portfolio, {}, Date.now(), { positions: async () => ({ rows: [{ value: NaN, currency: 'USD' }], fx: null }) });
    assert.equal(result.total, null); assert.match(result.dividendNote, /no configurado/);
});

test('no envía un resumen de antes de la activación ni durante no molestar', async () => {
    const now = Date.parse('2026-11-05T13:00:00Z'); let portfolioReads = 0;
    const config = { _id: 'alice', enabled: true, enabledAt: new Date('2026-11-05T12:30:00Z'), frequency: 'daily', time: '09:00', day: 1, channels: 'push' };
    const db = { collection(name) {
        if (name === 'scheduled_summaries') return { find: () => ({ toArray: async () => [config] }) };
        if (name === 'users') return { findOne: async () => ({ _id: 'alice' }) };
        if (name === 'portfolios') return { findOne: async () => { portfolioReads++; return { portfolio: { preferences: { quietHours: { enabled: true, start: '08:00', end: '11:00' } }, investments: [] } }; } };
        throw new Error(`No debería acceder a ${name}`);
    } };
    await checkScheduledSummaries(db, {}, now);
    assert.equal(portfolioReads, 0);
    config.enabledAt = new Date('2026-11-04T12:00:00Z');
    await checkScheduledSummaries(db, {}, now);
    assert.equal(portfolioReads, 1);
});

test('envía una vez por canal, guarda el valor y reintenta el canal fallido', async () => {
    const now = Date.parse('2026-11-05T13:00:00Z');
    const config = { _id: 'alice', enabled: true, enabledAt: new Date('2026-11-04T00:00:00Z'), frequency: 'daily', time: '09:00', day: 1, channels: 'both' };
    const deliveries = new Set(), snapshots = [], messages = []; let failTg = true;
    const db = { collection(name) {
        if (name === 'scheduled_summaries') return { find: () => ({ toArray: async () => [config] }) };
        if (name === 'users') return { findOne: async () => ({ _id: 'alice' }) };
        if (name === 'portfolios') return { findOne: async () => ({ portfolio: { investments: [], preferences: {} } }) };
        if (name === 'push_subscriptions') return { find: () => ({ toArray: async () => [{ _id: 'device', userId: 'alice' }] }) };
        if (name === 'telegram_subscriptions') return { findOne: async () => ({ _id: 'alice', chatId: '123' }) };
        if (name === 'summary_deliveries') return { insertOne: async row => { if (deliveries.has(row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 }); deliveries.add(row._id); }, deleteOne: async row => deliveries.delete(row._id) };
        if (name === 'summary_snapshots') return { find: filter => ({ sort: () => ({ limit: () => ({ toArray: async () => snapshots.filter(row => row.slot < filter.slot.$lt).sort((a, b) => b.slot.localeCompare(a.slot)).slice(0, 1) }) }) }), updateOne: async (_filter, update) => { snapshots.push(update.$setOnInsert); } };
        throw new Error(name);
    } };
    snapshots.push({ slot: '2026-11-04', currency: 'USD', total: 90 });
    const opts = { build: async () => ({ currency: 'USD', total: 100, payments: [], dividendNote: '' }), sendWeb: async (_db, _row, payload) => { messages.push(['push', payload]); return true; }, sendTg: async (_db, _row, payload) => { if (failTg) throw new Error('offline'); messages.push(['telegram', payload]); return true; } };
    await checkScheduledSummaries(db, { TELEGRAM_BOT_TOKEN: 'test' }, now, opts);
    assert.equal(messages.length, 1); assert.match(messages[0][1].body, /2026-11-04/); assert.match(messages[0][1].body, /aportes y retiros/);
    failTg = false;
    await checkScheduledSummaries(db, { TELEGRAM_BOT_TOKEN: 'test' }, now + 300000, opts);
    await checkScheduledSummaries(db, { TELEGRAM_BOT_TOKEN: 'test' }, now + 600000, opts);
    assert.deepEqual(messages.map(message => message[0]), ['push', 'telegram']);
});
