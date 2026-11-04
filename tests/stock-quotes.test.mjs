import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stockQuotes } from '../server/stock-quotes.mjs';

test('returns only valid USD prices for the requested symbol', async () => {
    const fetcher = async url => ({ ok: true, json: async () => ({ chart: { result: [{ meta: url.includes('ITUB') ? { symbol: 'ITUB', currency: 'USD', regularMarketPrice: 9.5 } : { symbol: 'OTHER', currency: 'ARS', regularMarketPrice: 20 } }] } }) });
    assert.deepEqual(await stockQuotes(['ITUB', 'OTHER', 'ITUB', '../bad'], fetcher), { ITUB: 9.5 });
});

test('keeps available quotes when another request fails', async () => {
    const fetcher = async url => {
        if (url.includes('FAIL')) throw new Error('unavailable');
        return { ok: true, json: async () => ({ chart: { result: [{ meta: { symbol: 'ITUB', currency: 'USD', regularMarketPrice: 9.5 } }] } }) };
    };
    assert.deepEqual(await stockQuotes(['ITUB', 'FAIL'], fetcher), { ITUB: 9.5 });
    await assert.rejects(stockQuotes(['FAIL'], fetcher));
});
