import { HttpError } from './security.mjs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createWorker } from 'tesseract.js';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/spa/package.json')), '4.0.0_best_int');
const types = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12', enero:'01', febrero:'02', marzo:'03', abril:'04', mayo:'05', junio:'06', julio:'07', agosto:'08', septiembre:'09', octubre:'10', noviembre:'11', diciembre:'12' };
function sum(values) {
    const digits = Math.max(...values.map(v => (v.split('.')[1] || '').length));
    const total = values.reduce((a,v) => { const [i,f=''] = v.split('.'); return a + BigInt(i + f.padEnd(digits,'0')); }, 0n).toString().padStart(digits + 1,'0');
    return digits ? `${total.slice(0,-digits)}.${total.slice(-digits)}`.replace(/\.?0+$/, '') : total;
}
function multiply(a,b) {
    const decimals = (a.split('.')[1] || '').length + (b.split('.')[1] || '').length;
    const result = (BigInt(a.replace('.','')) * BigInt(b.replace('.',''))).toString().padStart(decimals + 1,'0');
    return decimals ? `${result.slice(0,-decimals)}.${result.slice(-decimals)}`.replace(/\.?0+$/, '') : result;
}
export function parseAlpaca(text) {
    if (!/Alpaca/i.test(text)) return [];
    const operations = [];
    for (const section of text.split(/ORDER ID:\s*/i).slice(1)) {
        const header = section.match(/^([\da-f-]{36})\s+SYMBOL:\s*([A-Z.]+)\b/i);
        if (!header) continue;
        const rows = [...section.matchAll(/\b(buy|sell)\s+(\d+(?:\.\d+)?)\s+(USD|ARS)\s+(\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?\s+([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})/gi)];
        if (!rows.length) continue;
        const first = rows[0];
        if (rows.some(r => r[1].toLowerCase() !== first[1].toLowerCase() || r[3] !== first[3] || r[9] !== first[9] || r[10] !== first[10] || r[8] !== first[8])) continue;
        const date = `${first[10]}-${months[first[8].toLowerCase()]}-${first[9].padStart(2,'0')}`;
        if (!months[first[8].toLowerCase()]) continue;
        const executions = rows.map(r => ({ executionId: null, quantity:r[2], price:r[4], amount:r[5].replace('-',''), fee:r[7] ? r[6].replace('-','') : null }));
        operations.push({ asset:header[2].toUpperCase(), name:header[2].toUpperCase(), kind:'stock', side:first[1].toLowerCase(), date, quantity:sum(executions.map(e=>e.quantity)), price:executions.every(e=>e.price===executions[0].price) ? executions[0].price : null, amount:sum(rows.map(r=>(r[7] || r[6]).replace('-',''))), currency:first[3], fee:rows.every(r=>r[7]) ? sum(rows.map(r=>r[6].replace('-',''))) : null, externalId:header[1], executions });
    }
    return operations;
}
export function parseLemon(text) {
    if (!/lemon|lemmy/i.test(text) || !/compraste|vendiste/i.test(text)) return [];
    const amount = text.match(/\$?\s*([\d.]+)\s*(ARS|USD)\s*=\s*([\d.]+)\s+([A-Z0-9]+)/i);
    const date = text.match(/(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo),?\s*(\d{1,2})\s+(?:de\s+)?([a-z]+),?\s*(\d{4})/i);
    if (!amount || !date || !months[date[2].toLowerCase()]) return [];
    const price = text.match(/precio de (?:compra|venta)\s*(USD|ARS)\s*([\d.]+)\s*=\s*1\s+([A-Z0-9]+)/i);
    const exchange = text.match(/USD\s*1\s*=\s*([\d.]+)\s*ARS/i);
    const fee = text.match(/comisi[oó]n\s*(ARS|USD)\s*([\d.]+)/i);
    const id = text.match(/(?:ID|1D) de la operaci[oó]n\s*([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\b/i);
    const symbols = { BTC:'bitcoin', ETH:'ethereum', SOL:'solana', USDT:'tether', USDC:'usd-coin', XRP:'ripple', BNB:'binancecoin', DOGE:'dogecoin', ADA:'cardano' };
    const symbol = amount[4].toUpperCase(), currency = amount[2].toUpperCase();
    let unitPrice = null;
    if (price && price[3].toUpperCase() === symbol) {
        if (price[1].toUpperCase() === currency) unitPrice = price[2];
        else if (price[1].toUpperCase() === 'USD' && currency === 'ARS' && exchange) unitPrice = multiply(price[2], exchange[1]);
    }
    return [{ asset:symbols[symbol] || symbol, name:symbol, kind:'crypto', side:/vendiste/i.test(text) ? 'sell' : 'buy', date:`${date[3]}-${months[date[2].toLowerCase()]}-${date[1].padStart(2,'0')}`, quantity:amount[3], price:unitPrice, amount:amount[1], currency, fee:fee && fee[1].toUpperCase() === currency ? fee[2] : null, externalId:id?.[1] || null, executions:[] }];
}
export async function extractDocument(db, user, env, body) {
    if (!body || !types.has(body.type) || typeof body.data !== 'string' || body.data.length > 1_600_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) throw new HttpError(400, 'Subí un PDF o imagen JPG, PNG o WebP de hasta 1,2 MB.');
    const bytes = Buffer.from(body.data, 'base64');
    if (!bytes.length || bytes.length > 1_200_000 || bytes.toString('base64') !== body.data) throw new HttpError(400, 'Archivo inválido o demasiado grande.');
    const signature = body.type === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : body.type === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff : body.type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    if (!signature) throw new HttpError(400, 'El contenido no coincide con el formato declarado.');
    let text = '';
    try {
        if (body.type === 'application/pdf') {
            const task = pdfjs.getDocument({ data:new Uint8Array(bytes), useSystemFonts:true });
            const doc = await task.promise;
            if (doc.numPages > 30) throw new Error('too many pages');
            try { for (let i=1; i<=doc.numPages; i++) { const page = await doc.getPage(i); const content = await page.getTextContent(); text += content.items.map(item => item.str).join(' ') + '\n'; } } finally { await task.destroy(); }
        } else {
            const worker = await createWorker('spa', 1, { langPath, cacheMethod:'none' });
            try { text = (await worker.recognize(bytes)).data.text; } finally { await worker.terminate(); }
        }
    } catch { throw new HttpError(422, 'No se pudo leer el archivo. Verificá que no esté dañado o protegido.'); }
    return { operations:[...parseAlpaca(text), ...parseLemon(text)].slice(0,100) };
}

