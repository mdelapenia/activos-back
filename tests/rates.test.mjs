import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketRates, checkRatePush, detectSpikes, isMarketOpen, parseCauciones, parsePlazosFijos, ratePushPayload, rateOptions, ratesOverview } from '../server/rates.mjs';
import { validatePortfolio } from '../server/portfolio.mjs';

const open = Date.parse('2026-11-11T15:00:00Z'); // miércoles 12:00 en Argentina
const caucion = (plazo, tasaActual, montoContado = 1e9, fechaOperacion = '2026-11-11') => ({ plazo, montoContado, tasaActual, tasaMinDia: tasaActual, tasaMaxDia: tasaActual, fechaOperacion });
const bancos = [{ entidad: 'Banco A', tnaClientes: 0.19 }, { entidad: 'Banco B', tnaClientes: 0.25 }];

function fakeDb({ history = [], preferences = { rateAlerts: { enabled: true, channels: 'both' } } } = {}) {
    const deliveries = new Map(), stored = new Map();
    return { deliveries, stored, collection(name) {
        if (name === 'push_subscriptions') return { find: () => ({ toArray: async () => [{ _id: 'device', userId: 'user' }] }) };
        if (name === 'portfolios') return { findOne: async () => ({ portfolio: { investments: [], preferences } }) };
        if (name === 'rate_history') return {
            updateOne: async (filter, update) => { const row = stored.get(filter._id) ?? { sum: 0, count: 0 }; stored.set(filter._id, { ...row, ...update.$set, sum: row.sum + update.$inc.sum, count: row.count + 1 }); },
            find: filter => ({ sort: () => ({ limit: () => ({ toArray: async () => history.filter(row => row.date < filter.date.$lt) }) }) }),
        };
        if (name === 'push_deliveries') return {
            findOne: async ({ _id }) => deliveries.get(_id) ?? null,
            updateOne: async ({ _id }, update) => { deliveries.set(_id, { ...deliveries.get(_id), ...update.$set }); },
            deleteOne: async ({ _id }) => { deliveries.delete(_id); },
        };
        throw new Error(name);
    } };
}
const days = (bucket, rate) => ['2026-11-10', '2026-11-09', '2026-11-06'].map(date => ({ instrument: 'caucion-ars', bucket, date, sum: rate * 4, count: 4 }));

test('la rueda de cauciones abre de lunes a viernes en hora argentina', () => {
    assert.equal(isMarketOpen(open), true);
    assert.equal(isMarketOpen(Date.parse('2026-11-11T13:00:00Z')), false);
    assert.equal(isMarketOpen(Date.parse('2026-11-11T21:00:00Z')), false);
    assert.equal(isMarketOpen(Date.parse('2026-11-14T15:00:00Z')), false);
});

test('normaliza las respuestas del proveedor y descarta filas inválidas', () => {
    assert.deepEqual(parseCauciones([caucion(7, 23.6), { plazo: 0, tasaActual: 20, fechaOperacion: '2026-11-11' }, { plazo: 3, tasaActual: 'x' }, null]).map(row => row.plazo), [7]);
    assert.deepEqual(parsePlazosFijos(bancos), [{ entidad: 'Banco B', tna: 25 }, { entidad: 'Banco A', tna: 19 }]);
    assert.deepEqual(parseCauciones('error'), []);
});

test('agrupa por plazo usando la caución con más volumen e ignora operaciones chicas', () => {
    const rows = parseCauciones([caucion(5, 30, 5e9), caucion(7, 24, 9e9), caucion(47, 99, 100000)]);
    assert.deepEqual(bucketRates(rows), [{ bucket: 'w1', label: '1 semana', plazo: 7, tasa: 24, monto: 9e9 }]);
});

test('detecta la suba contra el historial y, sin historial, contra el mejor plazo fijo', () => {
    const buckets = [{ bucket: 'd1', plazo: 1, tasa: 180 }, { bucket: 'w1', plazo: 7, tasa: 26 }];
    assert.deepEqual(detectSpikes(buckets, { d1: 30, w1: 24 }, []).map(row => row.bucket), ['d1']);
    assert.deepEqual(detectSpikes(buckets, {}, parsePlazosFijos(bancos)).map(row => [row.bucket, row.reference]), [['d1', 'bank']]);
    assert.deepEqual(detectSpikes(buckets, {}, []), []);
});

test('el aviso muestra la ganancia y otras opciones de inversión', () => {
    const buckets = [{ bucket: 'd1', plazo: 1, tasa: 180 }, { bucket: 'w1', plazo: 7, tasa: 40 }];
    const payload = ratePushPayload({ ...buckets[0], usual: 30, reference: 'history' }, rateOptions(buckets, parsePlazosFijos(bancos)));
    assert.match(payload.title, /Caución a 1 día: 180% anual/);
    assert.match(payload.body, /Lo habitual para ese plazo es 30%/);
    assert.match(payload.body, /493/);
    assert.match(payload.body, /Caución 7 días: 40%/);
    assert.match(payload.body, /Plazo fijo Banco B: 25%/);
});

test('avisa una vez por día y repite solo si la tasa sigue subiendo', async () => {
    const db = fakeDb({ history: days('d1', 30) }), sent = [];
    const deliver = async (_db, _row, payload) => { sent.push(payload); };
    let tasa = 180;
    const load = async () => ({ cauciones: parseCauciones([caucion(1, tasa), caucion(7, 26)]), plazosFijos: parsePlazosFijos(bancos) });
    await checkRatePush(db, {}, open, { load, deliver });
    await checkRatePush(db, {}, open + 300000, { load, deliver });
    assert.equal(sent.length, 1);
    tasa = 240;
    await checkRatePush(db, {}, open + 600000, { load, deliver });
    assert.equal(sent.length, 2);
    assert.equal(db.stored.get('caucion-ars:d1:2026-11-11').count, 3);
});

test('no avisa con datos viejos, fuera de rueda, sin suba o con la alerta apagada', async () => {
    const sent = [], deliver = async (_db, _row, payload) => { sent.push(payload); };
    const spike = async () => ({ cauciones: parseCauciones([caucion(1, 180)]), plazosFijos: [] });
    await checkRatePush(fakeDb({ history: days('d1', 30) }), {}, open, { load: async () => ({ cauciones: parseCauciones([caucion(1, 180, 1e9, '2026-11-05')]), plazosFijos: [] }), deliver });
    await checkRatePush(fakeDb({ history: days('d1', 30) }), {}, Date.parse('2026-11-14T15:00:00Z'), { load: spike, deliver });
    await checkRatePush(fakeDb({ history: days('d1', 30) }), {}, open, { load: async () => ({ cauciones: parseCauciones([caucion(1, 33)]), plazosFijos: [] }), deliver });
    await checkRatePush(fakeDb({ history: days('d1', 30), preferences: {} }), {}, open, { load: spike, deliver });
    await checkRatePush(fakeDb({ history: days('d1', 30), preferences: { rateAlerts: { enabled: true, channels: 'telegram' } } }), {}, open, { load: spike, deliver });
    await checkRatePush(fakeDb({ history: days('d1', 30), preferences: { rateAlerts: { enabled: true, channels: 'both' }, quietHours: { enabled: true, start: '09:00', end: '18:00' } } }), {}, open, { load: spike, deliver });
    assert.equal(sent.length, 0);
});

test('si el envío falla se puede reintentar en la próxima revisión', async () => {
    const db = fakeDb({ history: days('d1', 30) });
    const load = async () => ({ cauciones: parseCauciones([caucion(1, 180)]), plazosFijos: [] });
    let calls = 0;
    await checkRatePush(db, {}, open, { load, deliver: async () => { calls++; throw new Error('caído'); } });
    await checkRatePush(db, {}, open, { load, deliver: async () => { calls++; } });
    assert.equal(calls, 2);
});

test('la vista de tasas marca si el dato es de hoy y compara con lo habitual', async () => {
    const db = fakeDb({ history: days('w1', 24) });
    const stale = await ratesOverview(db, open, async () => ({ cauciones: parseCauciones([caucion(7, 23.6, 1e9, '2026-11-05')]), plazosFijos: parsePlazosFijos(bancos) }));
    assert.equal(stale.live, false);
    assert.equal(stale.fecha, '2026-11-05');
    assert.equal(stale.cauciones[0].usual, 24);
    assert.equal(stale.cauciones[0].bucket, 'w1');
    assert.deepEqual(stale.history[0], { bucket: 'w1', date: '2026-11-10', tasa: 24 });
    assert.deepEqual(stale.spikes, []);
    assert.equal(stale.options.length, 3);
    const live = await ratesOverview(db, open, async () => ({ cauciones: parseCauciones([caucion(7, 40)]), plazosFijos: [] }));
    assert.equal(live.live, true);
    assert.equal(live.spikes[0].plazo, 7);
});

test('la cartera acepta la preferencia de alertas de tasas y rechaza valores inválidos', () => {
    const base = { investments: [], preferences: { theme: 'dark', dollar: 'bolsa', hidden: false, sidebarCollapsed: false, display: 'USD', horizon: 12 } };
    const withAlerts = { ...base, preferences: { ...base.preferences, rateAlerts: { enabled: true, channels: 'telegram' } } };
    assert.deepEqual(validatePortfolio(withAlerts).preferences.rateAlerts, { enabled: true, channels: 'telegram' });
    assert.equal(validatePortfolio(base).preferences.rateAlerts, undefined);
    assert.throws(() => validatePortfolio({ ...base, preferences: { ...base.preferences, rateAlerts: { enabled: true, channels: 'sms' } } }));
    assert.throws(() => validatePortfolio({ ...base, preferences: { ...base.preferences, rateAlerts: { enabled: 'si', channels: 'push' } } }));
});
