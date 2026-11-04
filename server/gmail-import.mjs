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
import { extractDocument, parseLemon } from './import-extract.mjs';

export async function gmailReadImports(db, user, env, fetcher = fetch, sender = '') {
    if (typeof sender !== 'string' || (sender && (sender.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(sender)))) throw new HttpError(400, 'Ingresá una dirección de correo válida.');
    const { key } = config(env);
    const connection = await db.collection('gmail_connections').findOne({ _id: user._id });
    if (!connection) throw new HttpError(400, 'Conectá tu cuenta de Gmail primero.');
    const refreshToken = unseal(connection.refreshToken, key, user._id);
    const tokenResponse = await fetcher('https://oauth2.googleapis.com/token', { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body:new URLSearchParams({ client_id:env.GOOGLE_CLIENT_ID, client_secret:env.GOOGLE_CLIENT_SECRET, refresh_token:refreshToken, grant_type:'refresh_token' }), signal:AbortSignal.timeout(20000) });
    if (!tokenResponse.ok) throw new HttpError(502, 'No se pudo renovar el acceso a Gmail. Volvé a conectar la cuenta.');
    const token = await tokenResponse.json();
    if (!token.access_token) throw new HttpError(502, 'Google no entregó acceso a Gmail.');
    const get = async path => {
        const response = await fetcher(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers:{ Authorization:`Bearer ${token.access_token}` }, signal:AbortSignal.timeout(20000) });
        if (!response.ok) throw new HttpError(502, 'No se pudieron consultar los correos de Gmail.');
        return response.json();
    };
    const params = new URLSearchParams({ q:sender ? `from:${sender}` : '{from:lemoncash.com.ar from:lemon.me}', maxResults:'50' });
    const list = await get(`messages?${params}`);
    if (list.messages !== undefined && !Array.isArray(list.messages)) throw new HttpError(502, 'Gmail devolvió una respuesta inválida.');
    const operations = []; let unreadable = 0;
    for (const row of list.messages || []) {
        if (typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(row.id)) continue;
        const message = await get(`messages/${encodeURIComponent(row.id)}?format=full`);
        const parts = []; const walk = (part, depth = 0) => { if (!part || depth > 15 || parts.length >= 200) return; parts.push(part); if (Array.isArray(part.parts)) part.parts.forEach(child => walk(child, depth + 1)); };
        walk(message.payload);
        const subject = (message.payload?.headers || []).find(h => h.name?.toLowerCase() === 'subject')?.value || 'Comprobante Lemon';
        const candidates = [];
        const textPart = parts.find(p => p.mimeType === 'text/plain' && p.body?.data && !p.filename) || parts.find(p => p.mimeType === 'text/html' && p.body?.data && !p.filename);
        if (textPart) {
            let text = Buffer.from(textPart.body.data, 'base64url').toString('utf8').slice(0, 200000);
            if (textPart.mimeType === 'text/html') text = text.replace(/<\s*br\s*\/?>|<\/(?:p|div|tr|li|h[1-6])\s*>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&');
            parseLemon(text).forEach((op, index) => candidates.push({ op, part:`text-${index}` }));
        }
        for (const [index, part] of parts.entries()) {
            if (part.mimeType !== 'application/pdf' || (part.body?.size || 0) > 1200000) continue;
            let data = part.body?.data;
            if (!data && part.body?.attachmentId) { const attachment = await get(`messages/${encodeURIComponent(row.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`); data = attachment.data; }
            if (typeof data !== 'string' || data.length > 1600000) { unreadable++; continue; }
            const bytes = Buffer.from(data, 'base64url');
            try { const extracted = await extractDocument(db, user, env, { type:'application/pdf', data:bytes.toString('base64') }); extracted.operations.forEach((op, opIndex) => candidates.push({ op, part:`pdf-${index}-${opIndex}` })); } catch { unreadable++; }
        }
        for (const { op, part } of candidates) {
            const id = createHash('sha256').update(`${row.id}:${part}`).digest('hex').slice(0, 32);
            operations.push({ ...op, importId:`gmail-${id}`, source:`Gmail · ${String(subject).slice(0, 200)}` });
        }
    }
    return { operations, unreadable, truncated: Boolean(list.nextPageToken) };
}
