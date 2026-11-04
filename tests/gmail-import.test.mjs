import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gmailStart, gmailStatus } from '../server/gmail-import.mjs';

test('Gmail pide solo lectura, acceso offline y usa PKCE con estado temporal', async () => {
    const rows = []; const db = { collection: () => ({ insertOne: async row => rows.push(row), findOne: async () => null }) };
    const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REDIRECT_URI: 'https://app.example/api/imports/gmail/callback', APP_ORIGIN: 'https://app.example', GMAIL_TOKEN_KEY: Buffer.alloc(32, 1).toString('base64') };
    const result = await gmailStart(db, { _id: 'user-1' }, env, 1000);
    const url = new URL(result.url);
    assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]._id, url.searchParams.get('state'));
    assert.equal(rows[0].expiresAt.getTime(), 601000);
    assert.equal(typeof rows[0].verifier.data, 'string');
    assert.deepEqual(await gmailStatus(db, { _id: 'user-1' }, {}), { configured: false, connected: false, email: null });
});

test('consulta Gmail y extrae el texto de Lemon sin modificar el correo', async () => {
    const { createCipheriv } = await import('node:crypto');
    const { gmailReadImports } = await import('../server/gmail-import.mjs');
    const key = Buffer.alloc(32, 7), iv = Buffer.alloc(12, 2), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('gmail:user-1'));
    const encrypted = Buffer.concat([cipher.update('refresh','utf8'),cipher.final()]);
    const db = { collection: () => ({ findOne: async () => ({ refreshToken:{ iv:iv.toString('base64'), data:encrypted.toString('base64'), tag:cipher.getAuthTag().toString('base64') } }) }) };
    const env = { GOOGLE_CLIENT_ID:'id', GOOGLE_CLIENT_SECRET:'secret', GOOGLE_REDIRECT_URI:'http://localhost:3000/api/imports/gmail/callback', APP_ORIGIN:'http://localhost:5173', GMAIL_TOKEN_KEY:key.toString('base64') };
    const text = 'Lemon Compraste SOL\nMonto: $241.08 ARS = 0.00151474 SOL\nFecha Lunes, 02 noviembre, 2026\nPrecio de compra USD 94.541514 = 1 SOL\nTasa de cambio USD 1 = 1675 ARS\nComisión ARS 1.21';
    const calls = [];
    const fetcher = async (url, options) => {
        calls.push([String(url), options.method || 'GET']);
        if (String(url).includes('oauth2.googleapis.com')) return {ok:true,json:async()=>({access_token:'temporary'})};
        if (String(url).includes('?format=full')) return {ok:true,json:async()=>({payload:{mimeType:'text/plain',body:{data:Buffer.from(text).toString('base64url')},headers:[]}})};
        return {ok:true,json:async()=>({messages:[{id:'abc123'}]})};
    };
    const result = await gmailReadImports(db, { _id:'user-1' }, env, fetcher);
    assert.equal(result.operations[0].asset, 'solana'); assert.equal(result.operations[0].amount, '241.08');
    assert.ok(calls.some(([url]) => url.includes('lemoncash.com.ar')));
    assert.ok(calls.filter(([url]) => url.includes('gmail.googleapis.com')).every(([,method]) => method === 'GET'));
    assert.equal((await gmailReadImports(db, { _id:'user-1' }, env, fetcher, 'ejemplo@ejemplo.com')).operations[0].importId, result.operations[0].importId);
    assert.ok(calls.some(([url]) => new URL(url).searchParams.get('q') === 'from:ejemplo@ejemplo.com'));
    await assert.rejects(() => gmailReadImports(db, { _id:'user-1' }, env, fetcher, 'x@ejemplo.com OR from:otro'), /dirección de correo válida/);
});
