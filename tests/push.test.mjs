import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDividendPush, saveSubscription, testPush, isQuietHours, removeSubscription } from '../server/push.mjs';

const env = { VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_KEY: 'private', VAPID_SUBJECT: 'https://example.com', MASSIVE_API_KEY: 'test' };
test('respeta no molestar en hora argentina, incluso al cruzar medianoche', () => {
    const quiet = { enabled: true, start: '22:00', end: '08:00' };
    assert.equal(isQuietHours(quiet, Date.parse('2026-11-05T02:00:00Z')), true);
    assert.equal(isQuietHours(quiet, Date.parse('2026-11-05T10:59:00Z')), true);
    assert.equal(isQuietHours(quiet, Date.parse('2026-11-05T11:00:00Z')), false);
    assert.equal(isQuietHours({ ...quiet, enabled: false }, Date.parse('2026-11-05T02:00:00Z')), false);
    assert.equal(isQuietHours({ enabled: true, start: '09:00', end: '17:00' }, Date.parse('2026-11-05T15:00:00Z')), true);
});
test('desactivar notificaciones solo borra la suscripción de la cuenta', async () => {
    let filter;
    const db = { collection: () => ({ deleteOne: async value => { filter = value; } }) };
    await removeSubscription(db, { _id: 'alice' }, 'https://example.com/push');
    assert.equal(filter.userId, 'alice');
    assert.match(filter._id, /^[a-f0-9]{64}$/);
});
test('solo avisa pagos elegibles dentro del plazo y evita duplicados por dispositivo', async () => {
    const sent = [], deliveries = new Set();
    const alert = { id: 'a', kind: 'dividend', assetKind: 'cedear', assetId: 'ITUB', assetName: 'ITUB', threshold: 7 };
    const db = { collection(name) {
        if (name === 'push_subscriptions') return { find: () => ({ toArray: async () => [{ _id: 'device', userId: 'user' }] }) };
        if (name === 'portfolios') return { findOne: async () => ({ portfolio: { alerts: [alert], investments: [] } }) };
        if (name === 'push_deliveries') return { insertOne: async row => { if (deliveries.has(row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 }); deliveries.add(row._id); }, deleteOne: async row => deliveries.delete(row._id) };
        throw new Error(name);
    } };
    const loadDividends = async () => ({ configured: true, items: [{ status: 'ok', kind: 'cedear', ticker: 'itub', events: [{ payDate: '2026-11-10', eligible: true }, { payDate: '2026-11-11', eligible: false }, { payDate: '2026-12-10', eligible: true }] }] });
    const deliver = async (_db, _row, payload) => { sent.push(payload); };
    await checkDividendPush(db, env, Date.parse('2026-11-05T15:00:00Z'), { loadDividends, deliver });
    await checkDividendPush(db, env, Date.parse('2026-11-05T15:00:00Z'), { loadDividends, deliver });
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /10\/11\/2026/);
});

test('rechaza destinos de push ajenos a proveedores admitidos', async () => {
    const subscription = { endpoint: 'https://example.com/push', keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) } };
    await assert.rejects(() => saveSubscription({}, { _id: 'user' }, subscription), { status: 400 });
});

test('con varios avisos pendientes envía solamente el más cercano', async () => {
    const sent = [], deliveries = new Set();
    const alerts = [7, 1, 0].map(threshold => ({ id: `a${threshold}`, kind: 'dividend', assetKind: 'cedear', assetId: 'ITUB', assetName: 'ITUB', threshold }));
    const db = { collection(name) {
        if (name === 'push_subscriptions') return { find: () => ({ toArray: async () => [{ _id: 'device', userId: 'user' }] }) };
        if (name === 'portfolios') return { findOne: async () => ({ portfolio: { alerts, investments: [] } }) };
        if (name === 'push_deliveries') return { insertOne: async row => { if (deliveries.has(row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 }); deliveries.add(row._id); }, deleteOne: async row => deliveries.delete(row._id) };
        throw new Error(name);
    } };
    const loadDividends = async () => ({ configured: true, items: [{ status: 'ok', kind: 'cedear', ticker: 'ITUB', events: [{ payDate: '2026-11-05', eligible: true }] }] });
    await checkDividendPush(db, env, Date.parse('2026-11-05T15:00:00Z'), { loadDividends, deliver: async () => { sent.push(true); } });
    assert.equal(sent.length, 1);
});

test('la prueba de una alerta exige que pertenezca a la cartera del usuario', async () => {
    const db = { collection(name) {
        if (name === 'push_subscriptions') return { findOne: async () => ({ _id: 'device' }) };
        if (name === 'portfolios') return { findOne: async () => ({ portfolio: { alerts: [] } }) };
        throw new Error(name);
    } };
    await assert.rejects(() => testPush(db, { _id: 'user' }, 'https://example.com', env, 'otra-alerta'), { status: 404 });
});

test('la prueba de precio identifica el activo y el umbral sin activar una alerta real', async () => {
    const db = { collection(name) {
        if (name === 'push_subscriptions') return { findOne: async () => ({ _id: 'device' }) };
        if (name === 'portfolios') return { findOne: async () => ({ portfolio: { alerts: [{ id: 'btc', kind: 'price', assetKind: 'crypto', assetName: 'Bitcoin', threshold: 80000, direction: 'below' }] } }) };
        throw new Error(name);
    } };
    let received;
    await testPush(db, { _id: 'user' }, 'https://example.com', env, 'btc', async (_db, _row, payload) => { received = payload; return true; });
    assert.match(received.title, /Bitcoin/);
    assert.match(received.body, /Prueba:.*80\.000/);
    assert.equal(received.url, '/precios');
});
