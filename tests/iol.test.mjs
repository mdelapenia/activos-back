import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ensureIndexes } from '../server/database.mjs';
import { buildHistory, businessDaysBetween, checkIdleCash, connectIol, disconnectIol, idlePayload, iolHistory, iolPortfolio, iolQuotes, iolStatus, maskUser, normalizeCash, normalizeOperation, normalizePosition, saveIdleAlert } from '../server/iol.mjs';
import { hashPin } from '../server/security.mjs';

let mongo, client, db, user;
const env = { IOL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
const pin = '482915';

before(async () => {
    mongo = await MongoMemoryServer.create();
    client = await new MongoClient(mongo.getUri()).connect();
    db = client.db('activos_iol_tests');
    await ensureIndexes(db);
    const { insertedId } = await db.collection('users').insertOne({ email: 'iol@example.test', pinHash: await hashPin(pin) });
    user = { _id: insertedId };
});
after(async () => { await client?.close(); await mongo?.stop(); });

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** IOL simulado (API nueva): tokens con vencimiento, refresh, posiciones, saldos, cotizaciones e historial. */
const wrap = data => ({ meta: { status_code: 200 }, data, error: null });
function fakeIol({ password = 'clave-iol', expiresIn = 900 } = {}) {
    const calls = [];
    let counter = 0;
    const fetcher = async (url, init = {}) => {
        calls.push({ url, init });
        if (url.endsWith('/auth/token')) {
            const params = JSON.parse(init.body);
            const okPassword = params.grant_type === 'password' && params.username === 'luciano@correo.com' && params.password === password;
            const okRefresh = params.grant_type === 'refresh_token' && params.refresh_token?.startsWith('refresh-');
            if (!okPassword && !okRefresh) return json(401, { meta: {}, data: null, error: { message: 'invalid_grant' } });
            counter++;
            return json(200, wrap({ access_token: `access-${counter}`, refresh_token: `refresh-${counter}`, expires_in: expiresIn, token_type: 'bearer' }));
        }
        const token = init.headers?.Authorization;
        if (!token?.startsWith('Bearer access-')) return json(401, {});
        if (url.endsWith('/broker/accounts/AR/positions')) return json(200, wrap({ positions: [
            { quantity: 10, instrument: { symbol: 'aapl', name: 'Apple CEDEAR', type: 'CEDEARS', exchange: 'BCBA', currency: 'ARS' }, market_value: { current_price: 15000, price_change_percent: 1.5 }, cost_basis: { average_entry_price: 12000, total_cost: 120000, entry_date: '2026-03-10T00:00:00' }, profit_loss: { unrealized_pl: 30000, unrealized_pl_percent: 25 } },
            { quantity: 0, instrument: { symbol: 'VACIO', type: 'ACCIONES', currency: 'ARS' }, market_value: { current_price: 1 } },
        ] }));
        if (url.endsWith('/broker/accounts/US/positions')) return json(200, wrap({ positions: [] }));
        if (url.endsWith('/broker/accounts/AR/balances')) return json(200, wrap({ ars: { available: { t0: 2500.5, t1: 2500.5 } }, usd: { available: { t0: 40 } } }));
        if (url.includes('/broker/market-data/AAPL/quote')) return json(200, wrap({ prices: { current: 15500 }, change: { percent: 2.1 } }));
        if (url.includes('/broker/market-data/AL30/quote')) return json(200, wrap({ prices: { current: 85600 }, change: { percent: -0.3 } }));
        if (url.includes('/broker/accounts/AR/portfolio/history')) return json(200, wrap({ status: 'complete', missing_dates: [], history: [
            { date: '2026-01-02', equity: { ars: 100000 }, cash_flow: { deposits: { ars: 0 }, withdrawals: { ars: 0 } } },
            { date: '2026-01-03', equity: { ars: 160000 }, cash_flow: { deposits: { ars: 50000 }, withdrawals: { ars: 0 } } },
            { date: '2026-01-04', equity: { ars: 152500 }, cash_flow: { deposits: { ars: 0 }, withdrawals: { ars: 0 } } },
        ] }));
        return json(404, {});
    };
    return { fetcher, calls };
}

test('conectar pide el PIN de Activos y no guarda la contraseña de IOL ni los tokens en claro', async () => {
    const iol = fakeIol();
    await assert.rejects(connectIol(db, user, { pin: '000111', username: 'luciano@correo.com', password: 'clave-iol' }, env, Date.now(), iol.fetcher), /PIN/);
    assert.equal(iol.calls.length, 0, 'sin PIN correcto no se llama a IOL');
    const status = await connectIol(db, user, { pin, username: 'luciano@correo.com', password: 'clave-iol' }, env, Date.now(), iol.fetcher);
    assert.equal(status.connected, true);
    assert.equal(status.user, 'lu•••@correo.com');
    const row = await db.collection('iol_connections').findOne({ _id: user._id });
    const raw = JSON.stringify(row);
    assert.ok(!raw.includes('clave-iol'), 'la contraseña de IOL no se guarda');
    assert.ok(!raw.includes('access-1') && !raw.includes('refresh-1'), 'los tokens se guardan cifrados');
    assert.ok(!JSON.stringify(status).includes('access-'), 'el estado no devuelve tokens');
});

test('lee el portafolio y el saldo de IOL, normalizados', async () => {
    const iol = fakeIol();
    await connectIol(db, user, { pin, username: 'luciano@correo.com', password: 'clave-iol' }, env, Date.now(), iol.fetcher);
    const result = await iolPortfolio(db, user, env, Date.now(), iol.fetcher);
    assert.equal(result.positions.length, 1, 'las posiciones vacías se ignoran');
    assert.deepEqual(result.positions[0], {
        symbol: 'AAPL', country: 'argentina', name: 'Apple CEDEAR', type: 'CEDEARS', market: 'BCBA', currency: 'ARS',
        quantity: 10, value: 150000, lastPrice: 15000, averagePrice: 12000, gain: 30000, gainPct: 25, dailyChangePct: 1.5, since: '2026-03-10',
    });
    assert.deepEqual(result.cash, [{ currency: 'ARS', available: 2500.5 }, { currency: 'USD', available: 40 }]);
    assert.ok(!JSON.stringify(result).includes('access-'));
});

test('renueva el token vencido con el refresh, sin pedir la contraseña', async () => {
    const iol = fakeIol({ expiresIn: 1 });
    const start = Date.now();
    await connectIol(db, user, { pin, username: 'luciano@correo.com', password: 'clave-iol' }, env, start, iol.fetcher);
    await iolPortfolio(db, user, env, start + 60_000, iol.fetcher);
    const grants = iol.calls.filter(c => c.url.endsWith('/auth/token')).map(c => JSON.parse(c.init.body).grant_type);
    assert.deepEqual(grants, ['password', 'refresh_token']);
});

test('si IOL rechaza el refresh, la conexión queda para reconectar', async () => {
    const iol = fakeIol({ expiresIn: 1 });
    const start = Date.now();
    await connectIol(db, user, { pin, username: 'luciano@correo.com', password: 'clave-iol' }, env, start, iol.fetcher);
    const broken = async (url, init) => url.endsWith('/auth/token') ? json(400, { error: 'invalid_grant' }) : iol.fetcher(url, init);
    await assert.rejects(iolPortfolio(db, user, env, start + 60_000, broken), error => error.code === 'IOL_RECONNECT');
    assert.equal((await iolStatus(db, user, env)).needsReconnect, true);
    // Reconectar con la contraseña lo arregla.
    await connectIol(db, user, { pin, username: 'luciano@correo.com', password: 'clave-iol' }, env, start + 61_000, iol.fetcher);
    assert.equal((await iolStatus(db, user, env)).needsReconnect, false);
});

test('contraseña de IOL incorrecta: error claro y límite de intentos', async () => {
    const iol = fakeIol();
    const other = { _id: (await db.collection('users').insertOne({ email: 'otro@example.test', pinHash: await hashPin(pin) })).insertedId };
    for (let i = 0; i < 5; i++) await assert.rejects(connectIol(db, other, { pin, username: 'luciano@correo.com', password: 'mal' }, env, Date.now(), iol.fetcher), error => error.code === 'IOL_INVALID');
    await assert.rejects(connectIol(db, other, { pin, username: 'luciano@correo.com', password: 'clave-iol' }, env, Date.now(), iol.fetcher), error => error.code === 'IOL_LOCKED');
});

test('sin clave de cifrado configurada no se conecta', async () => {
    await assert.rejects(connectIol(db, user, { pin, username: 'a', password: 'b' }, {}, Date.now(), fakeIol().fetcher), error => error.code === 'IOL_NOT_CONFIGURED');
    assert.equal((await iolStatus(db, user, {})).configured, false);
});

test('desconectar borra la conexión', async () => {
    await disconnectIol(db, user);
    assert.equal((await iolStatus(db, user, env)).connected, false);
    await assert.rejects(iolPortfolio(db, user, env, Date.now(), fakeIol().fetcher), error => error.code === 'IOL_NOT_CONNECTED');
});

test('normaliza datos raros de IOL sin romperse', () => {
    assert.equal(normalizePosition(null, 'argentina'), null);
    assert.equal(normalizePosition({ cantidad: 1, valorizado: 10, titulo: {} }, 'argentina'), null);
    assert.equal(normalizePosition({ cantidad: 2, valorizado: 10, titulo: { simbolo: 'AL30D', moneda: 'dolar_Estadounidense' } }, 'argentina').currency, 'USD');
    assert.deepEqual(normalizeCash({ cuentas: 'x' }), []);
    assert.equal(maskUser('ab'), 'a•••');
});


test('cotizaciones de IOL: precio por unidad (bonos cada 100 nominales) y variación', async () => {
    const iol = fakeIol();
    await connectIol(db, user, { pin, username: 'luciano@correo.com', password: 'clave-iol' }, env, Date.now(), iol.fetcher);
    const result = await iolQuotes(db, user, env, Date.now(), ['cedear:aapl', 'bond:AL30', 'crypto:bitcoin', 'cedear:../x'], iol.fetcher);
    assert.deepEqual(result.quotes, { 'cedear:aapl': { price: 15500, changePct: 2.1 }, 'bond:AL30': { price: 856, changePct: -0.3 } });
});

test('normaliza operaciones y descarta las que no son compra o venta', () => {
    assert.deepEqual(normalizeOperation({ tipo: 'Venta', simbolo: 'ggal', fechaOperada: '2026-02-03T10:00:00', cantidadOperada: 5, montoOperado: 30000, precioOperado: 6000 }),
        { side: 'sell', symbol: 'GGAL', date: '2026-02-03', quantity: 5, amount: 30000, price: 6000 });
    assert.equal(normalizeOperation({ tipo: 'Suscripción FCI', simbolo: 'X', fechaOrden: '2026-02-03', cantidad: 1 }), null);
});

test('arma el historial reconstruyendo tenencias hacia atrás con precios de cierre', () => {
    const points = buildHistory({
        from: '2026-01-01', to: '2026-01-05',
        positions: [{ symbol: 'AAPL', quantity: 10, value: 150000, lastPrice: 15000, averagePrice: 12000, gain: 30000, currency: 'ARS', type: 'CEDEARS' }],
        operations: [{ side: 'buy', symbol: 'AAPL', date: '2026-01-03', quantity: 4, amount: 52000, price: 13000 }],
        series: { AAPL: { '2026-01-01': 12000, '2026-01-03': 13000, '2026-01-04': 14000 } },
    });
    assert.deepEqual(points.map(p => p.date), ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
    assert.equal(points[0].value, 6 * 12000, 'antes de la compra tenía 6');
    assert.equal(points[1].value, 6 * 12000, 'sin cierre ese día se usa el último');
    assert.equal(points[2].value, 10 * 13000);
    assert.equal(points[4].value, 150000, 'hoy coincide con IOL');
    assert.equal(points[0].invested, 6 * 12000);
    assert.equal(points[2].invested, 6 * 12000 + 52000);
});

test('bonos: el historial usa el precio cada 100 nominales', () => {
    const points = buildHistory({
        from: '2026-01-01', to: '2026-01-02',
        positions: [{ symbol: 'AL30', quantity: 1000, value: 856000, lastPrice: 85600, averagePrice: 80000, currency: 'ARS', type: 'TitulosPublicos' }],
        operations: [], series: { AL30: { '2026-01-01': 80000 } },
    });
    assert.equal(points[0].value, 1000 * 800);
});

test('historial desde IOL: valor diario, invertido con depósitos, y caché', async () => {
    const iol = fakeIol();
    await connectIol(db, user, { pin, username: 'luciano@correo.com', password: 'clave-iol' }, env, Date.now(), iol.fetcher);
    const now = Date.parse('2026-11-18T15:00:00Z');
    const history = await iolHistory(db, user, env, now, iol.fetcher, { fresh: true });
    assert.deepEqual(history.points.map(p => [p.date, p.value, p.invested]), [['2026-01-02', 100000, 100000], ['2026-01-03', 160000, 150000], ['2026-01-04', 152500, 150000]]);
    const calls = iol.calls.length;
    await iolHistory(db, user, env, now + 60_000, iol.fetcher);
    assert.equal(iol.calls.length, calls, 'la segunda vez sale de la caché');
    assert.ok(!JSON.stringify(history).includes('access-'));
});

test('días hábiles entre fechas', () => {
    assert.equal(businessDaysBetween('2026-11-13', '2026-11-16'), 1, 'viernes → lunes');
    assert.equal(businessDaysBetween('2026-11-16', '2026-11-16'), 0);
    assert.equal(businessDaysBetween('2026-11-16', '2026-11-18'), 2);
});

test('aviso de plata parada: espera los días elegidos y avisa una vez por día', async () => {
    const iol = fakeIol();
    await connectIol(db, user, { pin, username: 'luciano@correo.com', password: 'clave-iol' }, env, Date.now(), iol.fetcher);
    await assert.rejects(saveIdleAlert(db, user, { enabled: true, minAmount: -1, days: 1, channels: 'both' }), /monto/);
    await saveIdleAlert(db, user, { enabled: true, minAmount: 1000, days: 1, channels: 'push' });
    assert.equal((await iolStatus(db, user, env)).idleAlert.minAmount, 1000);
    const sent = [];
    const deps = {
        fetcher: iol.fetcher, marketOpen: () => true, quiet: async () => false,
        rates: async () => ({ name: 'Caución 1 día', tna: 36.5, days: 1 }),
        subscriptions: async () => [{ channel: 'expo', userId: user._id }, { channel: 'telegram', userId: user._id }],
        deliver: async (_db, row, payload) => { sent.push({ row, payload }); },
    };
    const monday = Date.parse('2026-11-16T15:00:00Z');
    await checkIdleCash(db, env, monday, deps);
    assert.equal(sent.length, 0, 'el primer día empieza a contar');
    await checkIdleCash(db, env, monday + 24 * 3600_000, deps);
    assert.equal(sent.length, 1, 'al día hábil siguiente avisa, solo por push');
    assert.equal(sent[0].row.channel, 'expo');
    assert.match(sent[0].payload.title, /2\.50\d/);
    await checkIdleCash(db, env, monday + 24 * 3600_000 + 31 * 60_000, deps);
    assert.equal(sent.length, 1, 'no repite el mismo día');
});

test('mensaje del aviso con la caución del día', () => {
    const payload = idlePayload(100000, { name: 'Caución 1 día', tna: 36.5, days: 1 });
    assert.match(payload.body, /36,5% anual/);
    assert.match(payload.body, /100 por día/);
});
