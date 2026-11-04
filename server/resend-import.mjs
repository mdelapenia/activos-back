import { randomBytes, createHash } from 'node:crypto';
import { HttpError } from './security.mjs';
import { extractDocument, parseLemon } from './import-extract.mjs';

function configuration(env) {
    const domain = String(env.RESEND_INBOUND_DOMAIN || '').trim().toLowerCase();
    if (!env.RESEND_API_KEY || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) return null;
    return { domain, key: env.RESEND_API_KEY };
}
export async function resendAddress(db, user, env) {
    const config = configuration(env);
    if (!config) return { configured: false };
    const aliases = db.collection('resend_import_aliases');
    const alias = randomBytes(18).toString('hex');
    await aliases.updateOne({ _id: user._id }, { $setOnInsert: { alias } }, { upsert: true });
    const row = await aliases.findOne({ _id: user._id });
    return { configured: true, address: `${row.alias}@${config.domain}` };
}
const plainHtml = html => String(html || '').replace(/<\s*br\s*\/?>|<\/(?:p|div|tr|li|h[1-6])\s*>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)));
function recipientMatches(row, address) { return Array.isArray(row.to) && row.to.some(to => typeof to === 'string' && (to.trim().toLowerCase() === address || to.toLowerCase().includes(`<${address}>`))); }
export async function readResendImports(db, user, env, fetcher = fetch) {
    const config = configuration(env);
    if (!config) throw new HttpError(503, 'Resend todavía no está configurado en el servidor.');
    const { address } = await resendAddress(db, user, env);
    const getJson = async path => {
        const response = await fetcher(`https://api.resend.com${path}`, { headers: { Authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new HttpError(502, 'No se pudieron consultar los correos de Resend.');
        return response.json();
    };
    let after = '', more = false; const messages = [];
    for (let page = 0; page < 5; page++) {
        const data = await getJson(`/emails/receiving?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
        if (!Array.isArray(data.data)) throw new HttpError(502, 'Resend devolvió una respuesta inválida.');
        messages.push(...data.data.filter(row => recipientMatches(row, address)));
        more = Boolean(data.has_more);
        if (!more || !data.data.length) break;
        after = data.data.at(-1).id;
        if (!after) throw new HttpError(502, 'No se pudo continuar la consulta de Resend.');
    }
    const operations = []; let unreadable = 0, pdfCount = 0, unrecognized = 0;
    for (const message of messages.slice(0, 50)) {
        if (typeof message.id !== 'string' || !/^[\w-]{1,100}$/.test(message.id)) continue;
        const email = await getJson(`/emails/receiving/${encodeURIComponent(message.id)}`);
        if (!recipientMatches(email, address)) continue;
        const text = typeof email.text === 'string' && email.text.trim() ? email.text : plainHtml(email.html);
        const candidates = parseLemon(text.slice(0, 200000)).map((op, index) => ({ op, part: `text-${index}` }));
        const list = await getJson(`/emails/receiving/${encodeURIComponent(message.id)}/attachments?limit=100`);
        if (!Array.isArray(list.data)) throw new HttpError(502, 'No se pudieron consultar los adjuntos.');
        for (const attachment of list.data.filter(a => String(a.content_type || '').split(';')[0].trim().toLowerCase() === 'application/pdf' || (a.content_type === 'application/octet-stream' && /\.pdf$/i.test(a.filename || ''))).slice(0, 10)) {
            pdfCount++;
            if (!attachment.download_url || typeof attachment.id !== 'string' || (Number.isFinite(attachment.size) && attachment.size > 1200000)) { unreadable++; continue; }
            const url = new URL(attachment.download_url);
            if (url.protocol !== 'https:' || url.hostname !== 'inbound-cdn.resend.com' || url.username || url.password) { unreadable++; continue; }
            const response = await fetcher(url.toString(), { redirect: 'error', signal: AbortSignal.timeout(20000) });
            if (!response.ok || Number(response.headers.get('content-length') || 0) > 1200000) { unreadable++; continue; }
            let size = 0; const chunks = [];
            for await (const chunk of response.body) { size += chunk.length; if (size > 1200000) break; chunks.push(Buffer.from(chunk)); }
            if (size > 1200000) { unreadable++; continue; }
            const bytes = Buffer.concat(chunks);
            try { const result = await extractDocument(db, user, env, { type:'application/pdf', data:bytes.toString('base64') }); if (!result.operations.length) unrecognized++; result.operations.forEach((op, index) => candidates.push({ op, part:`pdf-${attachment.id}-${index}` })); }
            catch { unreadable++; }
        }
        for (const {op, part} of candidates) {
            const id = createHash('sha256').update(`${message.id}:${part}`).digest('hex').slice(0, 32);
            operations.push({ ...op, importId:`resend-${id}`, source:`Correo de Lemon · ${(message.subject || 'comprobante').slice(0, 200)}` });
        }
    }
    return { operations, unreadable, pdfCount, unrecognized, messageCount: Math.min(messages.length, 50), truncated: more || messages.length > 50 };
}
