import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { digest, HttpError, newToken } from './security.mjs';

const scope = 'https://www.googleapis.com/auth/gmail.readonly';
function config(env) {
    const key = Buffer.from(env.GMAIL_TOKEN_KEY || '', 'base64');
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI || !env.APP_ORIGIN || key.length !== 32 || key.toString('base64') !== env.GMAIL_TOKEN_KEY) throw new HttpError(503, 'Gmail no está configurado en el servidor.', 'GMAIL_NOT_CONFIGURED');
    const redirect = new URL(env.GOOGLE_REDIRECT_URI);
    if (redirect.protocol !== 'https:' && redirect.hostname !== 'localhost') throw new HttpError(503, 'La URL de Gmail debe usar HTTPS.', 'GMAIL_NOT_CONFIGURED');
    return { key, redirect: redirect.toString() };
}
function seal(value, key, userId) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`gmail:${userId}`));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function unseal(value, key, userId) {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    cipher.setAAD(Buffer.from(`gmail:${userId}`)); cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8');
}
export async function gmailStatus(db, user, env) {
    const row = await db.collection('gmail_connections').findOne({ _id: user._id });
    let configured = true; try { config(env); } catch { configured = false; }
    return { configured, connected: !!row, email: row?.email ?? null };
}
export async function gmailStart(db, user, env, now) {
    const { redirect, key } = config(env); const state = newToken(); const verifier = newToken();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await db.collection('gmail_oauth_states').insertOne({ _id: digest(state), userId: user._id, verifier: seal(verifier, key, user._id), expiresAt: new Date(now + 10 * 60_000) });
    const params = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope, access_type: 'offline', prompt: 'consent select_account', state, code_challenge: challenge, code_challenge_method: 'S256' });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
}
export async function gmailCallback(db, env, query, now) {
    const { key, redirect } = config(env); const state = query.get('state'); const code = query.get('code');
    if (!state || !/^[\w-]{43}$/.test(state)) throw new HttpError(400, 'Autorización de Gmail inválida.');
    const result = await db.collection('gmail_oauth_states').findOneAndDelete({ _id: digest(state), expiresAt: { $gt: new Date(now) } });
    const row = result?.value ?? result;
    if (!row?.userId || !code || code.length > 4096) throw new HttpError(400, 'La autorización venció o fue cancelada.');
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: unseal(row.verifier, key, row.userId) }), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new HttpError(502, 'Google no pudo autorizar la cuenta.');
    const token = await response.json();
    if (!token.refresh_token || !token.access_token || !String(token.scope || '').split(' ').includes(scope)) throw new HttpError(502, 'Google no entregó acceso de lectura sin conexión. Volvé a autorizar.');
    const profileResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(20000) });
    if (!profileResponse.ok) throw new HttpError(502, 'No se pudo verificar la cuenta de Gmail.');
    const profile = await profileResponse.json();
    if (typeof profile.emailAddress !== 'string' || !profile.emailAddress.includes('@')) throw new HttpError(502, 'Google no devolvió una cuenta válida.');
    await db.collection('gmail_connections').updateOne({ _id: row.userId }, { $set: { email: profile.emailAddress, refreshToken: seal(token.refresh_token, key, row.userId), updatedAt: new Date(now) } }, { upsert: true });
}
export async function gmailDisconnect(db, user, env) {
    const row = await db.collection('gmail_connections').findOne({ _id: user._id });
    if (row) {
        const { key } = config(env); const token = unseal(row.refreshToken, key, user._id);
        const response = await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(20000) });
        if (!response.ok && response.status !== 400) throw new HttpError(502, 'No se pudo revocar el acceso en Google. Reintentá.');
        await db.collection('gmail_connections').deleteOne({ _id: user._id });
    }
    return { connected: false };
}
