import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteAccount, USER_DATA } from '../server/account-deletion.mjs';
import { hashPin } from '../server/security.mjs';

function fakeDb(pinHash) {
    const deleted = [];
    const db = {
        deleted,
        collection: name => ({
            findOne: async () => name === 'users' ? { pinHash } : null,
            deleteMany: async filter => { deleted.push([name, filter]); },
            deleteOne: async filter => { deleted.push([name, filter]); },
            updateOne: async () => { },
        }),
    };
    return db;
}

test('borra la cuenta y todos sus datos con el PIN correcto', async () => {
    const db = fakeDb(await hashPin('123456'));
    let revoked = false;
    await deleteAccount(db, { _id: 'u1' }, { pin: '123456' }, {}, { revokeGmail: async () => { revoked = true; } });
    assert.equal(revoked, true);
    for (const [name, field] of USER_DATA) assert.ok(db.deleted.some(([n, f]) => n === name && f[field] === 'u1'), `falta borrar ${name}`);
    // La cuenta se borra al final.
    assert.deepEqual(db.deleted.at(-1), ['users', { _id: 'u1' }]);
});

test('no borra nada con un PIN incorrecto o inválido', async () => {
    const db = fakeDb(await hashPin('123456'));
    await assert.rejects(deleteAccount(db, { _id: 'u1' }, { pin: '000000' }, {}, { revokeGmail: async () => { } }), /incorrecto/);
    await assert.rejects(deleteAccount(db, { _id: 'u1' }, { pin: '12' }, {}, { revokeGmail: async () => { } }), /6 dígitos/);
    assert.equal(db.deleted.length, 0);
});

test('si Google no responde, igual se elimina la cuenta', async () => {
    const db = fakeDb(await hashPin('123456'));
    await deleteAccount(db, { _id: 'u1' }, { pin: '123456' }, {}, { revokeGmail: async () => { throw new Error('timeout'); } });
    assert.deepEqual(db.deleted.at(-1), ['users', { _id: 'u1' }]);
});
