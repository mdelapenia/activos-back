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
