// Reproducción (temporal, de debug) del flujo comprar con 2FA: previewOrder → placeOrder con el verifyMfa real,
// Mongo en memoria e IOL falso. Imprime qué status/código HTTP recibiría la app en cada caso.
// Uso: node scripts/repro-2fa-order.mjs
import { randomBytes, randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { generate } from 'otplib';
import { ensureIndexes } from '../server/database.mjs';
import { connectIol } from '../server/iol.mjs';
import { confirmMfaSetup, startMfaSetup, verifyMfa } from '../server/mfa.mjs';
import { hashPassword, hashPin } from '../server/security.mjs';
import { placeOrder, previewOrder } from '../server/trading.mjs';

const env = { IOL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
const pin = '482915', password = 'una clave bien larga';
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const wrap = data => ({ meta: { status_code: 200 }, data, error: null });
let iolMode = 'ok';
const sent = [];
const fetcher = async (url, init = {}) => {
    if (url.endsWith('/auth/token')) return json(200, wrap({ access_token: 'a', refresh_token: 'r', expires_in: 900 }));
    if (url.includes('/broker/market-data/AAPL/quote')) return json(200, wrap({ prices: { current: 10000 }, change: { percent: 1 } }));
    if (url.endsWith('/broker/accounts/AR/balances')) return json(200, wrap({ ars: { available: { t0: 3_000_000 } }, usd: { available: { t0: 500 } } }));
    if (url.endsWith('/broker/accounts/AR/positions')) return json(200, wrap({ positions: [] }));
    if (url.endsWith('/broker/orders/estimate')) return json(200, wrap({ commission: { value: 450 }, regulatory_fees: { market_fee: { value: 45 }, vat: { value: 94.5 } } }));
    if (init.method === 'POST' && url.endsWith('/broker/orders')) {
        if (iolMode === 'reject') return json(400, { meta: { status_code: 400 }, data: null, error: { message: 'Mercado cerrado' } });
        if (iolMode === 'reconnect') return json(401, {});
        sent.push(JSON.parse(init.body));
        return json(201, wrap({ order_id: String(1000 + sent.length), successful_purchase: true, messages: [] }));
    }
    return json(404, {});
};

const mongo = await MongoMemoryServer.create();
const client = await new MongoClient(mongo.getUri()).connect();
const db = client.db('repro_2fa');
await ensureIndexes(db);

let now = Date.parse('2026-11-18T15:00:00Z');
const H = 3600_000;
// iPhone vinculado hace 1 h → período de 24 h → needs.code.
const { insertedId } = await db.collection('users').insertOne({ email: 'repro@example.test', pinHash: await hashPin(pin), passwordHash: await hashPassword(password), passwordChangedAt: new Date(now - 240 * H) });
const deviceId = `device-${randomUUID()}`;
await db.collection('devices').insertOne({ _id: deviceId, publicId: randomUUID(), userId: insertedId, createdAt: new Date(now - H) });
const user = { _id: insertedId, deviceId, email: 'repro@example.test' };
await connectIol(db, user, { pin, username: 'u@correo.com', password: 'x' }, env, now - 48 * H, fetcher);
// 2FA activado hace 10 minutos.
const setup = await startMfaSetup(db, user, { pin }, env, now - 10 * 60_000);
await confirmMfaSetup(db, user, { pin, code: await generate({ secret: setup.secret, epoch: Math.floor((now - 10 * 60_000) / 1000) }) }, env, now - 10 * 60_000);
const codeAt = t => generate({ secret: setup.secret, epoch: Math.floor(t / 1000) });

const body = { side: 'buy', kind: 'cedear', symbol: 'AAPL', currency: 'ARS', amount: 100_000 };
async function step(label, fn) {
    try {
        const r = await fn();
        console.log(`✔ ${label}\n    → 200`, r.order ? { status: r.order.status, repeated: !!r.repeated, message: r.order.message ?? undefined } : r);
    } catch (e) {
        const status = e.status ?? 503;
        const logsOut = status === 401 && e.code !== 'INVALID_CREDENTIALS';
        console.log(`✘ ${label}\n    → ${status} ${e.code ?? '(sin code)'} "${e.message}"${logsOut ? '  ⚠ ESTE 401 CIERRA LA SESIÓN EN LA APP' : ''}`);
    }
}
const place = (extra, t = now) => placeOrder(db, user, { ...body, pin, ...extra }, env, t, { fetcher, verifyCode: verifyMfa });
const mfaRow = async () => (await db.collection('mfa').findOne({ _id: user._id })).lastStep;

console.log('\n=== Vista previa ===');
const preview = await previewOrder(db, user, body, env, now, fetcher);
console.log('needs =', preview.needs, 'cooldownUntil =', preview.cooldownUntil);
const before = await mfaRow();
await previewOrder(db, user, body, env, now, fetcher);
console.log('¿previewOrder consume el código? lastStep antes/después:', before, await mfaRow(), (before === await mfaRow()) ? '→ no' : '→ SÍ');

console.log('\n=== Casos de placeOrder (respuesta que vería la app) ===');
const goodCode = await codeAt(now);
await step('PIN incorrecto (código bueno)', () => place({ requestId: randomUUID(), pin: '000000', code: goodCode }));
console.log('    lastStep tras PIN incorrecto:', await mfaRow(), '(no cambia: el PIN se valida antes que el código)');
await step('Código 2FA incorrecto', () => place({ requestId: randomUUID(), code: '000000' }));
await step('Sin código', () => place({ requestId: randomUUID() }));
await step('Sin deviceId (sesión web)', () => placeOrder(db, { ...user, deviceId: null }, { ...body, pin, requestId: randomUUID(), code: goodCode }, env, now, { fetcher, verifyCode: verifyMfa }));
await db.collection('mfa_attempts').deleteMany({});

const rid = randomUUID();
await step('Código bueno + PIN bueno', () => place({ requestId: rid, code: goodCode }));
await step('Reintento con el MISMO requestId (doble toque)', () => place({ requestId: rid, code: goodCode }));
await step('Mismo código, requestId NUEVO (código reusado)', () => place({ requestId: randomUUID(), code: goodCode }));

console.log('\n=== Ventana de tiempo del código (copiado del autenticador y pegado después) ===');
for (const delay of [20, 40, 70, 240, 290, 330]) {
    now += 10 * 60_000; // casos separados: un código anterior al último usado se rechaza siempre
    await db.collection('mfa_attempts').deleteMany({});
    const copied = await codeAt(now - delay * 1000);
    await step(`Código generado hace ${delay} s`, () => place({ requestId: randomUUID(), code: copied }));
}

console.log('\n=== IOL ===');
now += 120_000; iolMode = 'reject';
const rj = await codeAt(now);
await step('IOL rechaza la orden', () => place({ requestId: randomUUID(), code: rj }));
now += 120_000; iolMode = 'reconnect';
await db.collection('iol_connections').updateOne({ _id: user._id }, { $set: { accessExpiresAt: new Date(0) } });
const rc = await codeAt(now);
await step('IOL pide reconectar (IOL_RECONNECT)', () => place({ requestId: randomUUID(), code: rc }));
iolMode = 'ok';
await db.collection('iol_connections').updateOne({ _id: user._id }, { $unset: { needsReconnect: 1 } });
await step('  …y la app reintenta con requestId nuevo y el mismo código', () => place({ requestId: randomUUID(), code: rc }));

console.log('\n=== Intentos ===');
now += 120_000;
for (let i = 1; i <= 6; i++) await step(`Código mal #${i}`, () => place({ requestId: randomUUID(), code: '111111' }));

console.log('\n=== Sin 2FA activo, en el período de 24 h ===');
await db.collection('mfa').deleteMany({});
await step('Orden sin 2FA (MFA_REQUIRED)', () => place({ requestId: randomUUID(), code: '123456' }));

await client.close(); await mongo.stop();
