import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
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

test('el estado de passkeys requiere sesión y cuenta solo las de la cuenta', async () => {
    assert.equal((await call('passkey/status')).status, 401);
    const first = await login('a@example.test');
    const second = await login('b@example.test');
    const a = await db.collection('users').findOne({ email: 'a@example.test' });
    await db.collection('passkeys').insertOne({ _id: 'status-test', userId: a._id });
    assert.equal((await call('passkey/status', { cookie: first.cookie.split(';')[0] })).body.count, 1);
    assert.equal((await call('passkey/status', { cookie: second.cookie.split(';')[0] })).body.count, 0);
});


test('cada cuenta puede eliminar solo sus propias passkeys', async () => {
    assert.equal((await call('passkey/remove', { method: 'POST', body: { id: 'status-test' } })).status, 401);
    const first = await login('a@example.test'), second = await login('b@example.test');
    const aCookie = first.cookie.split(';')[0], bCookie = second.cookie.split(';')[0];
    const listed = await call('passkey/status', { cookie: aCookie });
    assert.equal(listed.body.keys[0].id, 'status-test');
    assert.equal((await call('passkey/remove', { method: 'POST', cookie: bCookie, body: { id: 'status-test' } })).status, 404);
    assert.equal((await call('passkey/remove', { method: 'POST', cookie: aCookie, body: { id: 'status-test' } })).status, 200);
    assert.equal((await call('passkey/status', { cookie: aCookie })).body.count, 0);
});

test('OAuth MCP emite tokens PKCE, permite cambios autorizados y revoca el acceso', async () => {
    const registration = await fetch(`${base}/oauth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Prueba MCP', redirect_uris: ['http://127.0.0.1:4567/callback'], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(registration.status, 201);
    const { client_id: clientId } = await registration.json();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorizationUrl = new URL(`${base}/oauth/authorize`);
    authorizationUrl.search = new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:4567/callback',
        scope: 'portfolio:read portfolio:write', state: 'test-state', code_challenge: challenge,
        code_challenge_method: 'S256', resource: `${origin}/mcp`,
    });
    const page = await fetch(authorizationUrl);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Permitir que este agente agregue, edite o elimine inversiones/);
    assert.match(pageHtml, new RegExp(`action="${origin}/oauth/authorize"`));
    assert.match(page.headers.get('content-security-policy'), new RegExp(`form-action 'self' ${origin}`));
    const requestId = /name="request_id" value="([^"]+)"/.exec(pageHtml)?.[1];
    assert.ok(requestId);
    const approval = await fetch(`${base}/oauth/authorize`, {
        method: 'POST', headers: {
            Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            request_id: requestId, email: 'a@example.test', pin,
            approve: 'yes', grant_write: 'yes',
        }),
        redirect: 'manual',
    });
    assert.equal(approval.status, 303);
    const callback = new URL(approval.headers.get('location'));
    assert.equal(callback.searchParams.get('state'), 'test-state');
    const code = callback.searchParams.get('code');
    const tokenResponse = await fetch(`${base}/oauth/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code', client_id: clientId, code,
            redirect_uri: 'http://127.0.0.1:4567/callback', code_verifier: verifier, resource: `${origin}/mcp`,
        }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.scope, 'portfolio:read portfolio:write');

    const callMcp = (message) => fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(message),
    });
    const added = await callMcp({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'add_investment', arguments: { name: 'Tasa', amount: 250, currency: 'USD', date: '2026-01-03', kind: 'rate', rate: 8, period: 'year' } },
    });
    const addedResult = await added.json();
    assert.equal(added.status, 200);
    assert.equal(addedResult.result.isError, undefined);
    const savedInvestment = JSON.parse(addedResult.result.content[0].text).investments.find(item => item.name === 'Tasa');
    assert.ok(savedInvestment);

    const account = await login('a@example.test');
    const cookie = account.cookie.split(';')[0];
    const authorizations = await call('mcp/authorizations', { cookie });
    assert.equal(authorizations.body.authorizations[0].name, 'Prueba MCP');
    assert.deepEqual(authorizations.body.authorizations[0].scopes, ['portfolio:read', 'portfolio:write']);
    const user = await db.collection('users').findOne({ email: 'a@example.test' });
    await db.collection('oauth_grants').updateOne({ userId: user._id, clientId }, { $set: { scopes: ['portfolio:read'] } });
    const deniedWrite = await callMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remove_investment', arguments: { id: savedInvestment.id } } });
    assert.equal(deniedWrite.status, 401);
    assert.equal((await deniedWrite.json()).error, 'Se requiere autorización OAuth.');
    assert.equal((await call('mcp/authorizations', { method: 'DELETE', body: { id: clientId }, cookie })).status, 200);
    assert.equal((await callMcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).status, 401);
});
