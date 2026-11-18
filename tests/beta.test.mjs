import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHandler } from '../server/handler.mjs';
import { digest } from '../server/security.mjs';
import { USER_DATA } from '../server/account-deletion.mjs';

test('la beta exige sesión, valida y guarda inscripciones y mensajes vinculados a la cuenta', async () => {
    const token = 'a'.repeat(43), user = { _id: 'user-1', email: 'cuenta@example.com', name: 'Ana', passwordHash: 'hash' };
    let signup, feedback;
    const db = { collection(name) {
        if (name === 'sessions') return { findOne: async query => query._id === digest(token) ? { userId: user._id } : null };
        if (name === 'users') return { findOne: async query => query._id === user._id ? { ...user } : null };
        if (name === 'beta_signups') return { updateOne: async (filter, update, options) => { signup = { filter, update, options }; } };
        if (name === 'beta_feedback') return { insertOne: async row => { feedback = row; } };
        throw new Error(name);
    } };
    const server = createServer(createHandler({ database: async () => db, env: { NODE_ENV: 'production', APP_ORIGIN: 'https://example.com' }, clock: () => 1000 }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function post(path, body, authenticated = true) {
        const response = await fetch(`${base}/api/beta/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com', 'X-Activos-Request': '1', ...(authenticated ? { Cookie: `activos_session=${token}` } : {}) }, body: JSON.stringify(body) });
        return response.status;
    }
    const body = { name: ' Ana ', email: 'ANA@EXAMPLE.COM', device: 'iPhone', level: 'nuevo', frequency: 'diario', features: ['cartera', 'cartera'], brokers: ['IOL'], contact: false, comment: '', accepts: true };
    try {
        assert.equal(await post('signup', body, false), 401);
        assert.equal(await post('signup', { ...body, accepts: false }), 400);
        assert.equal(await post('signup', { ...body, features: ['desconocida'] }), 400);
        assert.equal(await post('signup', body), 200);
        assert.equal(signup.filter._id, user._id);
        assert.equal(signup.update.$set.email, 'ana@example.com');
        assert.deepEqual(signup.update.$set.features, ['cartera']);
        assert.equal(signup.options.upsert, true);
        assert.equal(await post('feedback', { type: 'idea', area: '', message: '   ', device: 'iPhone' }), 400);
        assert.equal(await post('feedback', { type: 'error', area: 'Cartera', message: 'No abre', device: 'iPhone' }), 200);
        assert.equal(feedback.userId, user._id);
        assert.equal(feedback.email, user.email);
        assert.equal(feedback.message, 'No abre');
        assert.ok(USER_DATA.some(([name, field]) => name === 'beta_signups' && field === '_id'));
        assert.ok(USER_DATA.some(([name, field]) => name === 'beta_feedback' && field === 'userId'));
    } finally { await new Promise(resolve => server.close(resolve)); }
});
