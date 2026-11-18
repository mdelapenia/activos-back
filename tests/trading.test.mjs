import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ensureIndexes } from '../server/database.mjs';
import { connectIol } from '../server/iol.mjs';
import { hashPassword, hashPin } from '../server/security.mjs';
import { cancelOrder, checkOpenOrders, dollarSymbol, listOrders, mapStatus, placeOrder, planOrder, previewOrder, tradeOptions } from '../server/trading.mjs';

let mongo, client, db, user;
const env = { IOL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };
const pin = '482915', password = 'una clave bien larga';
const DAY = 24 * 3600_000;
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** IOL simulado (API nueva) con saldo, tenencias, cotizaciones y órdenes. */
const wrap = data => ({ meta: { status_code: 200 }, data, error: null });
function fakeIol() {
    const sent = [];
    const fetcher = async (url, init = {}) => {
        if (url.endsWith('/auth/token')) return json(200, wrap({ access_token: 'access-x', refresh_token: 'refresh-x', expires_in: 900 }));
        if (url.includes('/broker/market-data/AAPL/quote')) return json(200, wrap({ prices: { current: 10000 }, change: { percent: 1 } }));
        if (url.includes('/broker/market-data/AAPLD/quote')) return json(200, wrap({ prices: { current: 8 }, change: { percent: 1 } }));
        if (url.includes('/broker/market-data/AL30/quote')) return json(200, wrap({ prices: { current: 85000 }, change: { percent: 0 } }));
        if (url.endsWith('/broker/accounts/AR/balances')) return json(200, wrap({ ars: { available: { t0: 3_000_000 } }, usd: { available: { t0: 500 } } }));
        if (url.endsWith('/broker/accounts/AR/positions')) return json(200, wrap({ positions: [
            { quantity: 10, instrument: { symbol: 'AAPL', type: 'CEDEARS', currency: 'ARS' }, market_value: { current_price: 10000 }, cost_basis: { total_cost: 90000 }, profit_loss: { unrealized_pl: 10000 } },
            { quantity: 1000, instrument: { symbol: 'IOLPORA', type: 'FCI', currency: 'ARS' }, market_value: { current_price: 50 }, cost_basis: { total_cost: 50000 }, profit_loss: { unrealized_pl: 0 } },
        ] }));
        if (url.endsWith('/broker/orders/estimate')) return json(200, wrap({ amount: { value: 90000 }, commission: { value: 450 }, regulatory_fees: { market_fee: { value: 45 }, vat: { value: 94.5 } } }));
        if (init.method === 'POST' && (url.endsWith('/broker/orders') || url.includes('/broker/mutual-funds/'))) {
            sent.push({ url, body: JSON.parse(init.body), key: init.headers['X-Idempotency-Key'] });
            return json(201, wrap(url.includes('mutual-funds') ? { transaction_id: String(2000 + sent.length), successful: true, messages: [] } : { order_id: String(1000 + sent.length), successful_purchase: true, messages: [] }));
        }
        if (init.method === 'DELETE') return json(200, wrap({ cancelled: true }));
        if (url.includes('/broker/accounts/activities/operations')) return json(200, wrap(sent.map((o, i) => ({ order_id: String(1000 + i + 1), status: 'completed' }))));
        return json(404, {});
    };
    return { fetcher, sent };
}

before(async () => {
    mongo = await MongoMemoryServer.create();
    client = await new MongoClient(mongo.getUri()).connect();
    db = client.db('activos_trading_tests');
    await ensureIndexes(db);
});
after(async () => { await client?.close(); await mongo?.stop(); });

// Cada prueba con una cuenta nueva, vinculada hace 2 días (fuera del bloqueo de 24 h).
let iol, now;
beforeEach(async () => {
    now = Date.parse('2026-11-18T15:00:00Z');
    iol = fakeIol();
    const { insertedId } = await db.collection('users').insertOne({ email: `${randomUUID()}@example.test`, pinHash: await hashPin(pin), passwordHash: await hashPassword(password), passwordChangedAt: new Date(now - 10 * DAY) });
    const deviceId = `device-${randomUUID()}`;
    await db.collection('devices').insertOne({ _id: deviceId, publicId: randomUUID(), userId: insertedId, createdAt: new Date(now - 10 * DAY) });
    user = { _id: insertedId, deviceId };
    await connectIol(db, user, { pin, username: 'u@correo.com', password: 'x' }, env, now - 2 * DAY, iol.fetcher);
});

const order = (extra = {}) => ({ requestId: randomUUID(), pin, side: 'buy', kind: 'cedear', symbol: 'AAPL', amount: 100_000, ...extra });
const noCode = async () => false, goodCode = async () => true;

test('compra por monto: cantidad que entra con el tope de +3%, orden límite en t0', async () => {
    const result = await placeOrder(db, user, order(), env, now, { fetcher: iol.fetcher, verifyCode: noCode });
    assert.equal(result.order.status, 'sent');
    assert.equal(result.order.quantity, 9, '100.000 / 10.300 = 9');
    assert.equal(iol.sent.length, 1);
    assert.deepEqual(iol.sent[0].body, { symbol: 'AAPL', market_id: 'BCBA', side: 'buy', order_type: 'limit', quantity: 9, limit_price: 10300, due_date: '2026-11-18', settlement_term: 'T0' });
    assert.ok(iol.sent[0].url.endsWith('/broker/orders'));
    assert.match(iol.sent[0].key, /^[\da-f-]{36}$/, 'manda clave de idempotencia');
});

test('el mismo requestId no manda la orden dos veces', async () => {
    const body = order();
    await placeOrder(db, user, body, env, now, { fetcher: iol.fetcher, verifyCode: noCode });
    const again = await placeOrder(db, user, body, env, now, { fetcher: iol.fetcher, verifyCode: noCode });
    assert.equal(again.repeated, true);
    assert.equal(iol.sent.length, 1);
});

test('sin PIN correcto o desde la web no se opera', async () => {
    await assert.rejects(placeOrder(db, user, order({ pin: '000111' }), env, now, { fetcher: iol.fetcher, verifyCode: noCode }), /PIN/);
    await assert.rejects(placeOrder(db, { _id: user._id, deviceId: null }, order(), env, now, { fetcher: iol.fetcher, verifyCode: noCode }), error => error.code === 'IPHONE_ONLY');
    assert.equal(iol.sent.length, 0);
});

test('venta: bonos con precio cada 100 nominales y tope de −3%; no se vende más de lo que tenés', async () => {
    await db.collection('iol_orders').deleteMany({ userId: user._id });
    await assert.rejects(placeOrder(db, user, order({ side: 'sell', quantity: 11 }), env, now, { fetcher: iol.fetcher, verifyCode: noCode }), error => error.code === 'NO_HOLDING');
    const sold = await placeOrder(db, user, order({ side: 'sell', quantity: 4, amount: undefined }), env, now, { fetcher: iol.fetcher, verifyCode: noCode });
    assert.equal(sold.order.quantity, 4);
    assert.equal(iol.sent[0].body.limit_price, 9700);
    assert.equal(iol.sent[0].body.side, 'sell');
    const plan = planOrder({ side: 'buy', kind: 'bond', symbol: 'AL30', amount: 100_000 }, { unitPrice: 850, cash: 1e6 });
    assert.equal(plan.quantity, Math.floor(100_000 / (850 * 1.03)));
});

test('límite por orden: pide contraseña + 2FA, y sin 2FA activo no se puede', async () => {
    const big = order({ amount: 600_000 });
    await assert.rejects(placeOrder(db, user, big, env, now, { fetcher: iol.fetcher, verifyCode: goodCode }), error => error.code === 'MFA_REQUIRED');
    await db.collection('mfa').insertOne({ _id: user._id, enabled: true });
    await assert.rejects(placeOrder(db, user, { ...big, requestId: randomUUID(), password: 'mal' }, env, now, { fetcher: iol.fetcher, verifyCode: goodCode }), /contraseña/);
    await assert.rejects(placeOrder(db, user, { ...big, requestId: randomUUID(), password }, env, now, { fetcher: iol.fetcher, verifyCode: noCode }), /código/);
    const ok = await placeOrder(db, user, { ...big, requestId: randomUUID(), password, code: '123456' }, env, now, { fetcher: iol.fetcher, verifyCode: goodCode });
    assert.equal(ok.order.status, 'sent');
    assert.equal(iol.sent.length, 1, 'solo la autorizada llegó a IOL');
});

test('límite diario: suma lo operado en el día', async () => {
    for (let i = 0; i < 4; i++) await placeOrder(db, user, order({ amount: 450_000 }), env, now, { fetcher: iol.fetcher, verifyCode: noCode });
    const preview = await previewOrder(db, user, { side: 'buy', kind: 'cedear', symbol: 'AAPL', amount: 450_000 }, env, now, iol.fetcher);
    assert.equal(preview.needs.override, true, 'la quinta pasa los $2.000.000 del día');
    await assert.rejects(placeOrder(db, user, order({ amount: 450_000 }), env, now, { fetcher: iol.fetcher, verifyCode: noCode }), error => error.code === 'MFA_REQUIRED');
});

test('24 h sin operar después de reconectar IOL, salvo con el código 2FA', async () => {
    await connectIol(db, user, { pin, username: 'u@correo.com', password: 'x' }, env, now - 3600_000, iol.fetcher);
    const preview = await previewOrder(db, user, { side: 'buy', kind: 'cedear', symbol: 'AAPL', amount: 50_000 }, env, now, iol.fetcher);
    assert.equal(preview.needs.code, true);
    assert.ok(preview.cooldownUntil);
    await assert.rejects(placeOrder(db, user, order({ amount: 50_000 }), env, now, { fetcher: iol.fetcher, verifyCode: goodCode }), error => error.code === 'MFA_REQUIRED');
    await db.collection('mfa').insertOne({ _id: user._id, enabled: true });
    const ok = await placeOrder(db, user, order({ amount: 50_000, code: '123456' }), env, now, { fetcher: iol.fetcher, verifyCode: goodCode });
    assert.equal(ok.order.status, 'sent');
    // Pasadas las 24 h, alcanza el PIN.
    const later = await placeOrder(db, user, order({ amount: 50_000 }), env, now + DAY, { fetcher: iol.fetcher, verifyCode: noCode });
    assert.equal(later.order.status, 'sent');
});

test('FCI: suscripción por monto y rescate por cuotapartes', async () => {
    await placeOrder(db, user, order({ kind: 'fund', symbol: 'IOLPORA', amount: 20_000 }), env, now, { fetcher: iol.fetcher, verifyCode: noCode });
    await placeOrder(db, user, order({ kind: 'fund', symbol: 'IOLPORA', side: 'sell', quantity: 100, amount: undefined }), env, now, { fetcher: iol.fetcher, verifyCode: noCode });
    assert.ok(iol.sent[0].url.endsWith('/broker/mutual-funds/subscriptions'));
    assert.deepEqual(iol.sent[0].body, { symbol: 'IOLPORA', amount: 20_000 });
    assert.ok(iol.sent[1].url.endsWith('/broker/mutual-funds/redemptions'));
    assert.deepEqual(iol.sent[1].body, { symbol: 'IOLPORA', quantity: 100 });
});

test('si IOL rechaza la orden queda registrada como rechazada', async () => {
    const rejecting = async (url, init) => init?.method === 'POST' && url.endsWith('/broker/orders') ? json(400, { meta: {}, data: null, error: { message: 'Saldo insuficiente' } }) : iol.fetcher(url, init);
    const result = await placeOrder(db, user, order(), env, now, { fetcher: rejecting, verifyCode: noCode });
    assert.equal(result.order.status, 'rejected');
    assert.match(result.order.message, /Saldo insuficiente/);
    const saved = await db.collection('iol_orders').findOne({ userId: user._id });
    assert.equal(saved.status, 'rejected');
});

test('si se corta la conexión al enviar, queda "sin confirmar" y no se reintenta', async () => {
    let posts = 0;
    const cut = async (url, init) => { if (init?.method === 'POST' && url.endsWith('/broker/orders')) { posts++; throw new Error('socket hang up'); } return iol.fetcher(url, init); };
    const result = await placeOrder(db, user, order(), env, now, { fetcher: cut, verifyCode: noCode });
    assert.equal(result.order.status, 'unknown');
    assert.equal(posts, 1);
});

test('la vista previa trae la comisión estimada por IOL', async () => {
    const preview = await previewOrder(db, user, { side: 'buy', kind: 'cedear', symbol: 'AAPL', amount: 100_000 }, env, now, iol.fetcher);
    assert.deepEqual(preview.fees, { commission: 450, taxes: 139.5, total: 589.5 });
});

test('IOL rechaza la orden con 201 pero sin éxito: queda rechazada', async () => {
    const refusing = async (url, init) => init?.method === 'POST' && url.endsWith('/broker/orders') ? json(201, wrap({ order_id: null, successful_purchase: false, messages: [{ code: 'X', message: 'Fuera de horario' }] })) : iol.fetcher(url, init);
    const { order: refused } = await placeOrder(db, user, order(), env, now, { fetcher: refusing, verifyCode: noCode });
    assert.equal(refused.status, 'rejected');
    assert.match(refused.message, /Fuera de horario/);
});

test('estados, cancelación y avisos de órdenes', async () => {
    assert.equal(mapStatus('Terminada'), 'executed');
    assert.equal(mapStatus('Cancelada'), 'cancelled');
    assert.equal(mapStatus('Pendiente'), 'pending');
    const placed = await placeOrder(db, user, order(), env, now, { fetcher: iol.fetcher, verifyCode: noCode });
    const toCancel = await placeOrder(db, user, order(), env, now, { fetcher: iol.fetcher, verifyCode: noCode });
    assert.equal((await cancelOrder(db, user, toCancel.order.id, env, now, iol.fetcher)).order.status, 'cancelled');
    const notified = [];
    await checkOpenOrders(db, env, now, { fetcher: iol.fetcher, notify: async (id, o) => { if (String(id) === String(user._id)) notified.push(o.status); } });
    const { orders } = await listOrders(db, user, env, now, iol.fetcher, { refresh: false });
    assert.equal(orders.find(o => o.id === placed.order.id).status, 'executed');
    assert.deepEqual(notified, ['executed']);
});

test('pagar en dólares: compra la especie D con el saldo en USD y cuenta el límite en pesos', async () => {
    assert.equal(dollarSymbol('AAPL'), 'AAPLD');
    assert.equal(dollarSymbol('AL30D'), 'AL30D');
    const result = await placeOrder(db, user, order({ currency: 'USD', amount: 100 }), env, now, { fetcher: iol.fetcher, verifyCode: noCode });
    assert.equal(result.order.currency, 'USD');
    assert.equal(result.order.symbol, 'AAPLD');
    assert.equal(result.order.quantity, Math.floor(100 / (8 * 1.03)));
    assert.equal(iol.sent[0].body.symbol, 'AAPLD');
    const saved = await db.collection('iol_orders').findOne({ userId: user._id });
    assert.equal(saved.amountArs, Math.round(result.order.total * 1250 * 100) / 100, 'en pesos con el dólar implícito (10.000 / 8)');
    await assert.rejects(placeOrder(db, user, order({ currency: 'USD', amount: 600 }), env, now, { fetcher: iol.fetcher, verifyCode: noCode }), error => error.code === 'NO_CASH');
});

test('compra por cantidad y opciones de compra (precios en pesos y dólares, saldos)', async () => {
    const result = await placeOrder(db, user, order({ amount: undefined, quantity: 3 }), env, now, { fetcher: iol.fetcher, verifyCode: noCode });
    assert.equal(result.order.quantity, 3);
    const options = await tradeOptions(db, user, env, now, { kind: 'cedear', symbol: 'aapl' }, iol.fetcher);
    assert.deepEqual({ ars: options.ars.price, usd: options.usd, fx: options.fx, cash: options.cash, holding: options.holding.quantity }, { ars: 10000, usd: { symbol: 'AAPLD', price: 8 }, fx: 1250, cash: { ARS: 3_000_000, USD: 500 }, holding: 10 });
    const noUsd = await tradeOptions(db, user, env, now, { kind: 'bond', symbol: 'AL30' }, iol.fetcher);
    assert.equal(noUsd.usd, null, 'sin especie D cotizando, no se ofrece pagar en dólares');
});
