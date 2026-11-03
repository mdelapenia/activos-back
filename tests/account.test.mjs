import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ensureIndexes } from '../server/database.mjs';
import { createHandler } from '../server/handler.mjs';
import { digest, hashPin, verifyPin } from '../server/security.mjs';
import { emptyPortfolio } from '../server/portfolio.mjs';

let mongo, client, db, server, base;
const origin = 'https://activos.example.test';
const pin = '001234';

before(async () => {
    mongo = await MongoMemoryServer.create();
    client = await new MongoClient(mongo.getUri()).connect();
    db = client.db('activos_tests');
    await ensureIndexes(db);
    const pinHash = await hashPin(pin);
    await db.collection('users').insertMany(['a', 'b', 'limit', 'expiry'].map(name => ({ email: `${name}@example.test`, pinHash })));
    server = createServer(createHandler({ database: async () => db, env: { APP_ORIGIN: origin, NODE_ENV: 'production' } }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await client?.close();
    await mongo?.stop();
});

async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
    const response = await fetch(`${base}/api/${path}`, {
        method,
        headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Activos-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie'), headers: response.headers };
}
const login = email => call('login', { method: 'POST', body: { email, pin } });
const mutation = (version, portfolio) => ({ version, portfolio, mutationId: crypto.randomUUID() });

test('PIN fijo: salt distinto, verificación y ceros iniciales', async () => {
    const first = await hashPin(pin), second = await hashPin(pin);
    assert.notEqual(first, second);
    assert.equal(await verifyPin(pin, first), true);
    assert.equal(await verifyPin('123456', first), false);
    assert.equal(await verifyPin(pin, null), false);
    assert.equal(await verifyPin(pin, pin), false);
    await assert.rejects(hashPin('1234'));
});

test('sin sesión no se puede leer ni escribir una cartera', async () => {
    assert.equal((await call('session')).status, 401);
    assert.equal((await call('portfolio')).status, 401);
    assert.equal((await call('portfolio', { method: 'PUT', body: mutation(0, emptyPortfolio()) })).status, 401);
});

test('crea cuentas con PIN protegido, inicia sesión y evita duplicados', async () => {
    const body = { email: ' New@Example.Test ', pin, confirmPin: pin };
    const created = await call('register', { method: 'POST', body });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.email, 'new@example.test');
    assert.deepEqual(created.body.portfolio, emptyPortfolio());
    const user = await db.collection('users').findOne({ email: 'new@example.test' });
    assert.match(user.pinHash, /^scrypt-v1\$/);
    assert.equal(user.pin, undefined);
    assert.equal((await call('session', { cookie: created.cookie.split(';')[0] })).status, 200);
    assert.equal((await call('register', { method: 'POST', body })).status, 409);
    assert.equal((await call('register', { method: 'POST', body: { ...body, email: 'mismatch@example.test', confirmPin: '654321' } })).status, 400);
    assert.equal(await db.collection('users').countDocuments({ email: 'mismatch@example.test' }), 0);
});

test('acceso por correo/PIN, cookie protegida y cartera aislada por usuario', async () => {
    const auth = await login(' A@EXAMPLE.TEST ');
    assert.equal(auth.status, 200);
    assert.equal(auth.body.user.email, 'a@example.test');
    assert.ok(!JSON.stringify(auth.body).includes('pinHash'));
    assert.match(auth.cookie, /HttpOnly/);
    assert.match(auth.cookie, /SameSite=None/);
    assert.match(auth.cookie, /Secure/);
    assert.equal(auth.headers.get('cache-control'), 'no-store');
    const cookie = auth.cookie.split(';')[0];
    const token = cookie.split('=')[1];
    assert.ok(await db.collection('sessions').findOne({ _id: digest(token) }));
    assert.equal(await db.collection('sessions').findOne({ _id: token }), null);

    const portfolio = emptyPortfolio();
    portfolio.investments = [
        { id: 'btc', name: 'Bitcoin', amount: 500, currency: 'USD', date: '2026-01-05', kind: 'crypto', coin: 'bitcoin', units: 0.005 },
        { id: 'aapl', name: 'Apple', amount: 20000, currency: 'ARS', date: '2026-01-05', kind: 'cedear', coin: 'AAPL', units: 2 },
        { id: 'rate', name: 'Tasa', amount: 1000, currency: 'USD', date: '2026-01-05', kind: 'rate', rate: 10, period: 'year' },
    ];
    portfolio.preferences = { ...portfolio.preferences, theme: 'light', hidden: true, dollar: 'blue', display: 'ARS', horizon: 36, sidebarCollapsed: true };
    const change = mutation(0, portfolio);
    assert.equal((await call('portfolio', { method: 'PUT', cookie, body: change })).status, 200);
    assert.deepEqual((await call('portfolio', { cookie })).body.portfolio, portfolio);
    assert.equal((await call('portfolio', { method: 'PUT', cookie, body: change })).body.version, 1);
    const second = await login('b@example.test');
    const otherCookie = second.cookie.split(';')[0];
    assert.equal((await call(`portfolio?userId=${auth.body.user.id}`, { cookie: otherCookie })).body.portfolio.investments.length, 0);
    assert.equal((await call('portfolio', { method: 'PUT', cookie: otherCookie, body: { ...mutation(0, emptyPortfolio()), userId: auth.body.user.id } })).status, 200);
    assert.equal((await call('portfolio', { cookie })).body.portfolio.investments.length, 3);

    portfolio.investments = [portfolio.investments[0]];
    portfolio.investments[0].amount = 600;
    assert.equal((await call('portfolio', { method: 'PUT', cookie, body: mutation(1, portfolio) })).status, 200);
    assert.deepEqual((await call('portfolio', { cookie })).body.portfolio, portfolio);
    assert.equal((await call('logout', { method: 'POST', cookie, body: {} })).status, 200);
    assert.equal((await call('portfolio', { cookie })).status, 401);
});

test('ediciones simultáneas no sobrescriben versiones más recientes', async () => {
    const auth = await login('a@example.test');
    const cookie = auth.cookie.split(';')[0];
    const snapshot = (await call('portfolio', { cookie })).body;
    const a = mutation(snapshot.version, { ...snapshot.portfolio, preferences: { ...snapshot.portfolio.preferences, theme: 'dark' } });
    const b = mutation(snapshot.version, { ...snapshot.portfolio, preferences: { ...snapshot.portfolio.preferences, display: 'USD' } });
    const responses = await Promise.all([a, b].map(body => call('portfolio', { method: 'PUT', cookie, body })));
    assert.deepEqual(responses.map(result => result.status).sort(), [200, 409]);
    const current = (await call('portfolio', { cookie })).body;
    assert.equal(current.version, snapshot.version + 1);
    assert.deepEqual(current.portfolio, responses[0].status === 200 ? a.portfolio : b.portfolio);
});

test('rechaza CSRF, tipos inválidos, fechas imposibles, IDs duplicados y cuerpos grandes', async () => {
    assert.equal((await call('login', { method: 'POST', body: { email: 'a@example.test', pin }, headers: { Origin: 'https://otro.example.test' } })).status, 403);
    assert.equal((await call('login', { method: 'POST', body: { email: 'a@example.test', pin }, headers: { 'X-Activos-Request': '' } })).status, 403);
    assert.equal((await call('login', { method: 'POST', body: { email: { $ne: null }, pin } })).status, 400);
    assert.equal((await call('login')).status, 405);
    const auth = await login('b@example.test');
    const cookie = auth.cookie.split(';')[0];
    const invalid = { id: 'bad', name: 'Bad', kind: 'rate', amount: 1, currency: 'USD', date: '2026-02-31', rate: 10, period: 'year' };
    assert.equal((await call('portfolio', { method: 'PUT', cookie, body: mutation(1, { ...emptyPortfolio(), investments: [invalid] }) })).status, 400);
    invalid.date = '2026-02-28';
    assert.equal((await call('portfolio', { method: 'PUT', cookie, body: mutation(1, { ...emptyPortfolio(), investments: [invalid, invalid] }) })).status, 400);
    assert.equal((await call('portfolio', { method: 'PUT', cookie, body: { data: 'x'.repeat(2_000_001) } })).status, 413);
});

test('permite reintentar el acceso y rechaza sesiones vencidas aunque Mongo aún no las haya eliminado', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await call('login', { method: 'POST', body: { email: 'limit@example.test', pin: '999999' } })).status, 401);
    assert.equal((await login('limit@example.test')).status, 200);
    const auth = await login('expiry@example.test');
    const cookie = auth.cookie.split(';')[0];
    await db.collection('sessions').updateOne({ _id: digest(cookie.split('=')[1]) }, { $set: { expiresAt: new Date(0) } });
    assert.equal((await call('session', { cookie })).status, 401);
});

test('passkeys exigen sesión para registrar y rechazan desafíos reutilizados', async () => {
    assert.equal((await call('passkey/register/options', { method: 'POST', body: {} })).status, 401);
    const auth = await login('a@example.test');
    const cookie = auth.cookie.split(';')[0];
    const registration = await call('passkey/register/options', { method: 'POST', body: {}, cookie });
    assert.equal(registration.status, 200);
    assert.equal(registration.body.options.rp.id, 'activos.example.test');
    const attempt = { challengeId: registration.body.challengeId, response: {} };
    assert.equal((await call('passkey/register/verify', { method: 'POST', body: attempt, cookie })).status, 400);
    assert.equal((await call('passkey/register/verify', { method: 'POST', body: attempt, cookie })).status, 400);
    const options = await call('passkey/login/options', { method: 'POST', body: {} });
    assert.equal(options.status, 200);
    const invalid = { challengeId: options.body.challengeId, response: { id: 'invalid' } };
    assert.equal((await call('passkey/login/verify', { method: 'POST', body: invalid })).status, 401);
    assert.equal((await call('passkey/login/verify', { method: 'POST', body: invalid })).status, 400);
});
