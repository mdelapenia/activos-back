import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ensureIndexes } from '../server/database.mjs';
import { createHandler } from '../server/handler.mjs';
import { digest, hashPin } from '../server/security.mjs';

let mongo, client, db, server, base;
const origin = 'https://activos.example.test';
const password = 'una clave bien larga';
const pin = '482915';
const iphone = { platform: 'ios', name: 'iPhone de Luciano' };

before(async () => {
    mongo = await MongoMemoryServer.create();
    client = await new MongoClient(mongo.getUri()).connect();
    db = client.db('activos_auth_tests');
    await ensureIndexes(db);
    await db.collection('users').insertOne({ email: 'legacy@example.test', pinHash: await hashPin('001234') });
    server = createServer(createHandler({ database: async () => db, env: { APP_ORIGIN: origin, NODE_ENV: 'production' } }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await client?.close();
    await mongo?.stop();
});

async function call(path, { method = 'GET', body, cookie, ip = '10.0.0.1' } = {}) {
    const response = await fetch(`${base}/api/${path}`, {
        method,
        headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Activos-Request': '1', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    return { status: response.status, body: await response.json(), cookie: setCookie?.split(';')[0], rawCookie: setCookie };
}
const account = email => ({ name: 'Luciano', email, password, confirmPassword: password, pin, confirmPin: pin });

test('registro desde el iPhone: vincula el dispositivo y guarda solo el hash del secreto', async () => {
    const created = await call('register', { method: 'POST', body: { ...account('ios@example.test'), device: iphone } });
    assert.equal(created.status, 201);
    assert.match(created.body.deviceToken, /^[\w-]{43}$/);
    assert.equal(created.body.device.name, 'iPhone de Luciano');
    assert.equal(created.body.device.lockAfterMs, 30_000);
    const stored = await db.collection('devices').findOne({ _id: digest(created.body.deviceToken) });
    assert.ok(stored);
    assert.equal(await db.collection('devices').findOne({ _id: created.body.deviceToken }), null);
    // La sesión del iPhone dura 12 horas; después se entra con el PIN.
    assert.match(created.rawCookie, /Max-Age=43200/);
    assert.equal((await call('session', { cookie: created.cookie })).body.device.name, 'iPhone de Luciano');
});

test('el PIN solo no alcanza: hace falta el secreto del iPhone', async () => {
    const linked = await call('login', { method: 'POST', body: { email: 'ios@example.test', password, device: iphone } });
    assert.equal(linked.status, 200);
    const unlocked = await call('unlock', { method: 'POST', body: { deviceToken: linked.body.deviceToken, pin } });
    assert.equal(unlocked.status, 200);
    assert.equal(unlocked.body.user.name, 'Luciano');
    assert.equal(unlocked.body.deviceToken, undefined, 'el secreto se entrega una sola vez');
    assert.equal((await call('session', { cookie: unlocked.cookie })).status, 200);
    assert.equal((await call('unlock', { method: 'POST', body: { deviceToken: 'x'.repeat(43), pin } })).status, 401);
    assert.equal((await call('unlock', { method: 'POST', body: { pin } })).status, 401);
});

test('5 PINs incorrectos desvinculan el iPhone y cierran sus sesiones', async () => {
    const linked = await call('login', { method: 'POST', body: { email: 'ios@example.test', password, device: iphone } });
    const deviceToken = linked.body.deviceToken;
    for (let i = 4; i >= 1; i--) {
        const wrong = await call('unlock', { method: 'POST', body: { deviceToken, pin: '000111' } });
        assert.equal(wrong.status, 401);
        assert.match(wrong.body.error, new RegExp(`${i} intento`));
    }
    const last = await call('unlock', { method: 'POST', body: { deviceToken, pin: '000111' } });
    assert.equal(last.status, 401);
    assert.equal(last.body.code, 'DEVICE_REVOKED');
    assert.equal((await call('unlock', { method: 'POST', body: { deviceToken, pin } })).status, 401, 'ni con el PIN correcto');
    assert.equal((await call('session', { cookie: linked.cookie })).status, 401);
});

test('un acierto reinicia el contador de PINs incorrectos', async () => {
    const linked = await call('login', { method: 'POST', body: { email: 'ios@example.test', password, device: iphone } });
    const deviceToken = linked.body.deviceToken;
    for (let i = 0; i < 4; i++) await call('unlock', { method: 'POST', body: { deviceToken, pin: '000111' } });
    assert.equal((await call('unlock', { method: 'POST', body: { deviceToken, pin } })).status, 200);
    assert.equal((await call('unlock', { method: 'POST', body: { deviceToken, pin: '000111' } })).status, 401);
    assert.equal((await call('unlock', { method: 'POST', body: { deviceToken, pin } })).status, 200);
});

test('el tiempo para volver a pedir el PIN se guarda en la base, por iPhone', async () => {
    const linked = await call('login', { method: 'POST', body: { email: 'ios@example.test', password, device: iphone } });
    const saved = await call('devices/current', { method: 'PUT', cookie: linked.cookie, body: { lockAfterMs: 300_000 } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.device.lockAfterMs, 300_000);
    assert.equal((await db.collection('devices').findOne({ _id: digest(linked.body.deviceToken) })).lockAfterMs, 300_000);
    assert.equal((await call('session', { cookie: linked.cookie })).body.device.lockAfterMs, 300_000);
    assert.equal((await call('devices/current', { method: 'PUT', cookie: linked.cookie, body: { lockAfterMs: 12345 } })).status, 400);
    const web = await call('login', { method: 'POST', body: { email: 'ios@example.test', password } });
    assert.equal((await call('devices/current', { method: 'PUT', cookie: web.cookie, body: { lockAfterMs: 0 } })).status, 400);
});

test('lista y desvincula dispositivos solo de la propia cuenta', async () => {
    const mine = await call('login', { method: 'POST', body: { email: 'ios@example.test', password, device: iphone } });
    const other = await call('register', { method: 'POST', body: { ...account('otro@example.test'), device: iphone } });
    const listed = await call('devices', { cookie: mine.cookie });
    assert.ok(listed.body.devices.length >= 1);
    assert.ok(listed.body.devices.some(device => device.current));
    assert.ok(!JSON.stringify(listed.body).includes(mine.body.deviceToken));
    const otherId = other.body.device.id;
    assert.equal((await call('devices', { method: 'DELETE', cookie: mine.cookie, body: { id: otherId } })).status, 404);
    const current = listed.body.devices.find(device => device.current);
    const removed = await call('devices', { method: 'DELETE', cookie: mine.cookie, body: { id: current.id } });
    assert.equal(removed.status, 200);
    assert.equal((await call('unlock', { method: 'POST', body: { deviceToken: mine.body.deviceToken, pin } })).status, 401);
    assert.equal((await call('session', { cookie: mine.cookie })).status, 401);
});

test('cambiar la contraseña desvincula los otros dispositivos y cierra las otras sesiones', async () => {
    await call('register', { method: 'POST', body: account('cambio@example.test') });
    const phone = await call('login', { method: 'POST', body: { email: 'cambio@example.test', password, device: iphone } });
    const web = await call('login', { method: 'POST', body: { email: 'cambio@example.test', password } });
    const next = 'otra clave todavía más larga';
    assert.equal((await call('password', { method: 'POST', cookie: web.cookie, body: { currentPassword: 'mal', newPassword: next, confirmPassword: next } })).status, 401);
    assert.equal((await call('password', { method: 'POST', cookie: web.cookie, body: { currentPassword: password, newPassword: next, confirmPassword: next } })).status, 200);
    assert.equal((await call('session', { cookie: web.cookie })).status, 200);
    assert.equal((await call('session', { cookie: phone.cookie })).status, 401);
    assert.equal((await call('unlock', { method: 'POST', body: { deviceToken: phone.body.deviceToken, pin } })).status, 401);
    assert.equal((await call('login', { method: 'POST', body: { email: 'cambio@example.test', password } })).status, 401);
    assert.equal((await call('login', { method: 'POST', body: { email: 'cambio@example.test', password: next } })).status, 200);
});

test('cuentas viejas: entran una vez con PIN y completan nombre y contraseña', async () => {
    assert.equal((await call('login', { method: 'POST', body: { email: 'legacy@example.test', password: '001234' } })).status, 401);
    const first = await call('login', { method: 'POST', body: { email: 'legacy@example.test', pin: '001234', legacy: true } });
    assert.equal(first.status, 200);
    assert.equal(first.body.setupRequired, true);
    assert.equal((await call('session', { cookie: first.cookie })).body.setupRequired, true);
    // Sin contraseña no se puede usar nada más que la sesión y completar la cuenta.
    assert.equal((await call('portfolio', { cookie: first.cookie })).status, 403);
    assert.equal((await call('devices', { cookie: first.cookie })).status, 403);
    assert.equal((await call('pin/verify', { method: 'POST', cookie: first.cookie, body: { pin: '001234' } })).status, 403);
    assert.equal((await call('account/setup', { method: 'POST', cookie: first.cookie, body: { name: 'Vieja', password: 'corta', confirmPassword: 'corta' } })).status, 400);
    assert.equal((await call('account/setup', { method: 'POST', cookie: first.cookie, body: { name: 'Vieja', password, confirmPassword: password } })).status, 200);
    assert.equal((await call('session', { cookie: first.cookie })).body.setupRequired, false);
    assert.equal((await call('portfolio', { cookie: first.cookie })).status, 200);
    assert.equal((await call('account/setup', { method: 'POST', cookie: first.cookie, body: { name: 'Otra', password, confirmPassword: password } })).status, 409);
    // Ya con contraseña, el ingreso con PIN deja de funcionar.
    assert.equal((await call('login', { method: 'POST', body: { email: 'legacy@example.test', pin: '001234', legacy: true } })).status, 401);
    assert.equal((await call('login', { method: 'POST', body: { email: 'legacy@example.test', password } })).status, 200);
});

test('recupera contraseña solo con PIN y código web vigente, una vez, y cierra las sesiones', async () => {
    const email = 'recuperar@example.test';
    const web = await call('register', { method: 'POST', body: account(email) });
    const phone = await call('login', { method: 'POST', body: { email, password, device: iphone } });
    assert.equal((await call('password/recovery-code', { method: 'POST', body: {} })).status, 401);
    const issue = () => call('password/recovery-code', { method: 'POST', cookie: web.cookie, body: {} });
    const first = await issue();
    assert.match(first.body.code, /^[A-F0-9]{12}$/);
    const user = await db.collection('users').findOne({ email });
    const saved = await db.collection('password_recovery').findOne({ _id: user._id });
    assert.equal(saved.codeHash, digest(first.body.code));
    assert.ok(!JSON.stringify(saved).includes(first.body.code));
    const second = await issue();
    const next = 'otra contraseña segura';
    const recovery = (code, value = pin) => ({ email, pin: value, code, newPassword: next, confirmPassword: next });
    assert.equal((await call('password/recover', { method: 'POST', body: recovery(first.body.code) })).status, 401);
    assert.equal((await call('password/recover', { method: 'POST', body: recovery(second.body.code, '000111') })).status, 401);
    assert.equal((await call('session', { cookie: web.cookie })).status, 200);
    assert.equal((await call('password/recover', { method: 'POST', body: recovery(second.body.code) })).status, 200);
    assert.equal((await call('password/recover', { method: 'POST', body: recovery(second.body.code) })).status, 401);
    assert.equal((await call('session', { cookie: web.cookie })).status, 401);
    assert.equal((await call('unlock', { method: 'POST', body: { deviceToken: phone.body.deviceToken, pin } })).status, 401);
    assert.equal((await call('login', { method: 'POST', body: { email, password } })).status, 401);
    assert.equal((await call('login', { method: 'POST', body: { email, password: next } })).status, 200);
});

test('rechaza códigos de recuperación vencidos sin cambiar la contraseña', async () => {
    const email = 'vencido@example.test';
    const web = await call('register', { method: 'POST', body: account(email) });
    const issued = await call('password/recovery-code', { method: 'POST', cookie: web.cookie, body: {} });
    const user = await db.collection('users').findOne({ email });
    await db.collection('password_recovery').updateOne({ _id: user._id }, { $set: { expiresAt: new Date(0) } });
    const next = 'otra contraseña segura';
    assert.equal((await call('password/recover', { method: 'POST', body: { email, pin, code: issued.body.code, newPassword: next, confirmPassword: next } })).status, 401);
    assert.equal((await call('login', { method: 'POST', body: { email, password } })).status, 200);
});

test('limita los intentos fallidos de recuperación por cuenta', async () => {
    const email = 'limite-recuperacion@example.test';
    const web = await call('register', { method: 'POST', body: account(email) });
    const issued = await call('password/recovery-code', { method: 'POST', cookie: web.cookie, body: {} });
    const next = 'otra contraseña segura';
    const attempt = value => call('password/recover', { method: 'POST', body: { email, pin: value, code: issued.body.code, newPassword: next, confirmPassword: next } });
    for (let i = 0; i < 5; i++) assert.equal((await attempt('000111')).status, 401);
    assert.equal((await attempt(pin)).status, 429);
    assert.equal((await call('session', { cookie: web.cookie })).status, 200);
});

test('limita registros por IP', async () => {
    const ip = '10.9.9.9';
    for (let i = 0; i < 10; i++) await call('register', { method: 'POST', ip, body: account(`spam${i}@example.test`) });
    assert.equal((await call('register', { method: 'POST', ip, body: account('spam-extra@example.test') })).status, 429);
});
