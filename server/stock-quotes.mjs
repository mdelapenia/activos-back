// Yahoo Finance provides USD quotes for US-listed shares and ADRs.
export async function stockQuotes(symbols, fetcher = fetch) {
    const unique = [...new Set(symbols)].filter(symbol => /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol)).slice(0, 30);
    const results = await Promise.allSettled(unique.map(async symbol => {
        const response = await fetcher(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Proveedor no disponible');
        const data = await response.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (meta?.symbol?.toUpperCase() !== symbol || meta.currency !== 'USD' || !Number.isFinite(meta.regularMarketPrice) || meta.regularMarketPrice <= 0) return null;
        return [symbol, meta.regularMarketPrice];
    }));
    if (results.length && results.every(result => result.status === 'rejected')) throw new Error('No se pudo consultar Yahoo Finance.');
    return Object.fromEntries(results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []));
}

export async function stockHistory(symbol, fetcher = fetch) {
    if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol)) throw new Error('Ticker inválido.');
    const response = await fetcher(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Historial no disponible.');
    const data = await response.json();
    const result = data?.chart?.result?.[0];
    if (result?.meta?.symbol?.toUpperCase() !== symbol || result?.meta?.currency !== 'USD' || !Array.isArray(result.timestamp)) throw new Error('Historial inválido.');
    const closes = result.indicators?.adjclose?.[0]?.adjclose || result.indicators?.quote?.[0]?.close || [];
    return result.timestamp.flatMap((time, i) => Number.isFinite(time) && Number.isFinite(closes[i]) && closes[i] > 0 ? [{ time: time * 1000, price: closes[i] }] : []);
}
