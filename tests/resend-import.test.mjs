import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readResendImports, resendAddress } from '../server/resend-import.mjs';

test('asigna una dirección privada y solo lee correos destinados a esa cuenta', async () => {
    const rows = new Map(); const db = { collection: () => ({ updateOne: async ({_id}, update) => { if (!rows.has(_id)) rows.set(_id, { _id, ...update.$setOnInsert }); }, findOne: async ({_id}) => rows.get(_id) }) };
    const env = { RESEND_API_KEY: 'test', RESEND_INBOUND_DOMAIN: 'test.resend.app' }; const user = { _id: 'user' };
    const { address } = await resendAddress(db, user, env);
    assert.equal((await resendAddress(db, user, env)).address, address);
    const text = 'Lemon Compraste SOL\nMonto: $241.08 ARS = 0.00151474 SOL\nFecha Lunes, 02 noviembre, 2026\nPrecio de compra USD 94.541514 = 1 SOL\nTasa de cambio USD 1 = 1675 ARS\nComisión ARS 1.21';
    const calls = [];
    const fetcher = async url => { calls.push(url); const path = new URL(url).pathname; if (path === '/emails/receiving') return {ok:true, json:async()=>({data:[{id:'one',to:[address],subject:'Lemon'}, {id:'other',to:['other@test.resend.app']}],has_more:false})}; if (path.endsWith('/attachments')) return {ok:true,json:async()=>({data:[]})}; return {ok:true,json:async()=>({to:[address],text})}; };
    const result = await readResendImports(db, user, env, fetcher);
    assert.equal(result.operations.length, 1); assert.equal(result.operations[0].asset, 'solana'); assert.equal(result.operations[0].amount, '241.08'); assert.ok(!calls.some(url => url.includes('other')));
    assert.equal((await readResendImports(db, user, env, fetcher)).operations[0].importId, result.operations[0].importId);
    assert.deepEqual(await resendAddress(db, user, {}), { configured:false });
});

test('lee un PDF adjunto y conserva identificadores estables', async () => {
    const { Readable } = await import('node:stream');
    const content = 'BT /F1 10 Tf 40 700 Td (Alpaca ORDER ID: bb0ddc78-d02d-4dee-807b-7db74cdd8774 SYMBOL: SPY buy 2 USD 10 -20 -20 Nov 02, 2026) Tj ET';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const bytes = Buffer.from(pdf);
    const db = { collection: () => ({ updateOne: async () => {}, findOne: async () => ({ alias:'private' }) }) };
    const user = { _id:'u' }, env = { RESEND_API_KEY:'test', RESEND_INBOUND_DOMAIN:'test.resend.app' }, address = 'private@test.resend.app';
    const fetcher = async url => {
        if (String(url).startsWith('https://inbound-cdn.resend.com/')) return { ok:true, headers:new Headers({ 'content-length': String(bytes.length) }), body:Readable.from([bytes]) };
        const path = new URL(url).pathname;
        if (path === '/emails/receiving') return { ok:true, json:async()=>({ data:[{id:'one',to:[address]}],has_more:false }) };
        if (path.endsWith('/attachments')) return { ok:true, json:async()=>({ data:[{id:'pdf',content_type:'application/pdf',download_url:'https://inbound-cdn.resend.com/test',size:bytes.length}] }) };
        return { ok:true, json:async()=>({to:[address],text:'Correo reenviado'}) };
    };
    const { operations } = await readResendImports(db,user,env,fetcher);
    assert.deepEqual(operations.map(op=>op.asset), ['SPY']);
    assert.match(operations[0].importId, /^resend-/);
});
