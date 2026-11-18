import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicIp, updateDeviceLocation } from '../server/device-location.mjs';

test('omite direcciones locales y rechaza entradas que no son IP', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '::1', 'fc00::1', '::ffff:10.0.0.1', 'bad.example/path']) assert.equal(publicIp(ip), null);
    assert.equal(publicIp('::ffff:8.8.8.8'), '8.8.8.8');
    assert.equal(publicIp('2606:4700:4700::1111'), '2606:4700:4700::1111');
});

test('guarda solo ubicación aproximada y evita repetir consultas para la misma IP', async () => {
    const device = { _id: 'device', userId: 'user' };
    let writes = 0, lookups = 0;
    const db = { collection: () => ({ updateOne: async (filter, update) => { writes++; assert.deepEqual(filter, { _id: 'device', userId: 'user' }); assert.ok(!JSON.stringify(update).includes('8.8.8.8')); } }) };
    const fetcher = async url => { lookups++; assert.match(url, /^https:\/\/ipwho\.is\//); return { ok: true, json: async () => ({ success: true, city: 'Buenos Aires', region: 'Buenos Aires', country: 'Argentina' }) }; };
    await updateDeviceLocation(db, device, '8.8.8.8', { fetcher });
    assert.deepEqual(device.location, { city: 'Buenos Aires', region: 'Buenos Aires', country: 'Argentina' });
    await updateDeviceLocation(db, device, '8.8.8.8', { fetcher });
    assert.equal(lookups, 1); assert.equal(writes, 1);
    await updateDeviceLocation(db, device, '1.1.1.1', { fetcher: async () => { throw new Error('sin red'); } });
    assert.equal(writes, 1);
});
