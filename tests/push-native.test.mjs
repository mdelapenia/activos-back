import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationSubscriptions, saveExpoToken, sendPush, testExpoPush } from '../server/push.mjs';

const TOKEN = 'ExponentPushToken[abcdefghijklmnop]';

test('las alertas de precio y dividendos no incluyen los iPhone; el radar de tasas sí', async () => {
    const queries = [];
    const db = { collection: () => ({ find: query => { queries.push(query); return { toArray: async () => [] }; } }) };
    await notificationSubscriptions(db, {});
    await notificationSubscriptions(db, {}, { native: true });
    assert.deepEqual(queries, [{ channel: { $ne: 'expo' } }, {}]);
});

test('guarda el token de Expo y rechaza identificadores inválidos', async () => {
    const writes = [];
    const db = { collection: () => ({ updateOne: async (filter, update) => { writes.push(update.$set); } }) };
    await saveExpoToken(db, { _id: 'user' }, { token: TOKEN, device: 'iPhone' });
    assert.equal(writes[0].channel, 'expo');
    assert.equal(writes[0].token, TOKEN);
    await assert.rejects(saveExpoToken(db, { _id: 'user' }, { token: 'https://evil.example/push' }), /no es válido/);
});

test('envía por Expo Push con título, cuerpo y enlace', async () => {
    let sent;
    const fetcher = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { ok: true, json: async () => ({ data: [{ status: 'ok', id: 'ticket' }] }) }; };
    const ok = await sendPush({}, { _id: 'device', channel: 'expo', token: TOKEN }, { title: 'Hola', body: 'Resumen', url: '/precios' }, {}, fetcher);
    assert.equal(ok, true);
    assert.equal(sent.url, 'https://exp.host/--/api/v2/push/send');
    assert.equal(sent.body[0].to, TOKEN);
    assert.equal(sent.body[0].data.url, '/precios');
});

test('borra el iPhone si Expo informa que ya no está registrado', async () => {
    const deleted = [];
    const db = { collection: () => ({ deleteOne: async filter => { deleted.push(filter); } }) };
    const fetcher = async () => ({ ok: true, json: async () => ({ data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] }) });
    assert.equal(await sendPush(db, { _id: 'device', channel: 'expo', token: TOKEN }, { title: 't', body: 'b' }, {}, fetcher), false);
    assert.deepEqual(deleted, [{ _id: 'device' }]);
});

test('la prueba exige que el iPhone esté activado', async () => {
    const db = { collection: () => ({ findOne: async () => null }) };
    await assert.rejects(testExpoPush(db, { _id: 'user' }, TOKEN, {}), /Activá las notificaciones/);
});
