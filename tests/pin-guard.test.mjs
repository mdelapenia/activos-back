import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPin } from '../server/pin-guard.mjs';
import { hashPin } from '../server/security.mjs';

// Base en memoria con las dos colecciones que usa el control de PIN.
async function memoryDb(pin = '123456') {
    const pinHash = await hashPin(pin);
    let attempt = null;
    return {
        get attempt() { return attempt; },
        collection: name => name === 'users'
            ? { findOne: async () => ({ pinHash }) }
            : {
                findOne: async () => attempt,
                updateOne: async (_filter, update) => { attempt = { ...attempt, ...update.$set }; },
                deleteOne: async () => { attempt = null; },
            },
    };
}

test('acepta el PIN correcto', async () => {
    const db = await memoryDb();
    await checkPin(db, { _id: 'u' }, '123456', 0);
});

test('rechaza un PIN incorrecto y avisa cuántos intentos quedan', async () => {
    const db = await memoryDb();
    await assert.rejects(checkPin(db, { _id: 'u' }, '000000', 0), err => err.status === 401 && /quedan 4 intentos/.test(err.message));
});

test('al quinto error bloquea 15 minutos, aunque después pongas el correcto', async () => {
    const db = await memoryDb();
    for (let i = 0; i < 5; i++) await assert.rejects(checkPin(db, { _id: 'u' }, '000000', 0));
    await assert.rejects(checkPin(db, { _id: 'u' }, '123456', 60_000), err => err.status === 429 && /14 minutos/.test(err.message));
    // Pasado el bloqueo, el PIN correcto vuelve a funcionar y limpia los intentos.
    await checkPin(db, { _id: 'u' }, '123456', 16 * 60_000);
    assert.equal(db.attempt, null);
});

test('un acierto reinicia el contador de errores', async () => {
    const db = await memoryDb();
    for (let i = 0; i < 3; i++) await assert.rejects(checkPin(db, { _id: 'u' }, '000000', 0));
    await checkPin(db, { _id: 'u' }, '123456', 0);
    await assert.rejects(checkPin(db, { _id: 'u' }, '000000', 0), /quedan 4 intentos/);
});
