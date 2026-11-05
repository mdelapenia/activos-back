import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDividendPush, saveSubscription, testPush, isQuietHours, removeSubscription, pushConfig, dividendPaymentWhen } from '../server/push.mjs';

const env = { VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_KEY: 'private', VAPID_SUBJECT: 'https://example.com', MASSIVE_API_KEY: 'test' };
test('describe la fecha relativa según el día en Argentina', () => {
    const now = Date.parse('2026-12-08T02:00:00Z');
    assert.equal(dividendPaymentWhen('2026-12-07', now), 'hoy (07/12/2026)');
    assert.equal(dividendPaymentWhen('2026-12-08', now), 'mañana (08/12/2026)');
    assert.equal(dividendPaymentWhen('2026-12-14', now), 'en 1 semana (14/12/2026)');
    assert.equal(dividendPaymentWhen('2026-12-21', now), 'en 2 semanas (21/12/2026)');
    assert.equal(dividendPaymentWhen('2026-12-10', now), 'en 3 días (10/12/2026)');
});
test('genera y reutiliza un único par VAPID en la base ante inicios simultáneos', async () => {
    let stored;
    const db = { collection: name => {
        assert.equal(name, 'push_config');
        return {
            findOne: async () => stored,
            updateOne: async (_filter, update) => { stored ??= { _id: 'vapid', ...update.$setOnInsert }; },
        };
    } };
    const configs = await Promise.all(Array.from({ length: 8 }, () => pushConfig(db, {})));
    assert.ok(configs.every(config => config.publicKey === configs[0].publicKey && config.privateKey === configs[0].privateKey));
    assert.equal((await pushConfig(db, {})).publicKey, configs[0].publicKey);
    assert.equal(configs[0].subject, 'https://activos-nu.vercel.app');
});
test('conserva las claves VAPID explícitas y rechaza una configuración parcial', async () => {
    assert.deepEqual(await pushConfig({}, env), { publicKey: 'public', privateKey: 'private', subject: 'https://example.com' });
    await assert.rejects(() => pushConfig({}, { VAPID_PUBLIC_KEY: 'public' }), { status: 503 });
});
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
    const loadDividends = async () => ({ configured: true, items: [{ status: 'ok', kind: 'cedear', ticker: 'itub', events: [{ payDate: '2026-11-10', eligible: true, estimatedGross: 1.25 }, { payDate: '2026-11-11', eligible: false }, { payDate: '2026-12-10', eligible: true }] }, { status: 'ok', kind: 'cedear', ticker: 'ITUB', events: [{ payDate: '2026-11-10', eligible: true, estimatedGross: 2.5 }] }] });
    const deliver = async (_db, _row, payload) => { sent.push(payload); };
    await checkDividendPush(db, env, Date.parse('2026-11-05T15:00:00Z'), { loadDividends, deliver });
    await checkDividendPush(db, env, Date.parse('2026-11-05T15:00:00Z'), { loadDividends, deliver });
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /10\/11\/2026/);
    assert.match(sent[0].body, /Estimado bruto:.*3,75/);
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

test('la prueba de dividendo suma el importe elegible de las posiciones del activo', async () => {
    const portfolio = { alerts: [{ id: 'itub', kind: 'dividend', assetKind: 'cedear', assetId: 'ITUB', assetName: 'ITUB' }], investments: [] };
    const db = { collection(name) {
        if (name === 'push_subscriptions') return { findOne: async () => ({ _id: 'device' }) };
        if (name === 'portfolios') return { findOne: async () => ({ portfolio }) };
        throw new Error(name);
    } };
    const result = { items: [
        { status: 'ok', kind: 'cedear', ticker: 'ITUB', events: [{ payDate: '2099-12-08', eligible: true, estimatedGross: 1.25 }] },
        { status: 'ok', kind: 'cedear', ticker: 'ITUB', events: [{ payDate: '2099-12-08', eligible: true, estimatedGross: 2.5 }] },
        { status: 'ok', kind: 'cedear', ticker: 'ITUB', events: [{ payDate: '2099-12-08', eligible: false, estimatedGross: 99 }] },
    ] };
    let received;
    await testPush(db, { _id: 'user' }, 'https://example.com', env, 'itub', async (_db, _row, payload) => { received = payload; return true; }, async () => result);
    assert.match(received.body, /Prueba: pago anunciado/);
    assert.match(received.body, /08\/12\/2099/);
    assert.match(received.body, /Estimado bruto:.*3,75/);
});

test('la prueba de dividendo aclara cuando no se puede consultar el importe', async () => {
    const db = { collection: name => name === 'push_subscriptions' ? { findOne: async () => ({ _id: 'device' }) } : { findOne: async () => ({ portfolio: { alerts: [{ id: 'itub', kind: 'dividend', assetKind: 'cedear', assetId: 'ITUB', assetName: 'ITUB' }] } }) } };
    let received;
    await testPush(db, { _id: 'user' }, 'https://example.com', env, 'itub', async (_db, _row, payload) => { received = payload; return true; }, async () => { throw new Error('provider'); });
    assert.match(received.body, /no se pudo consultar/);
});
