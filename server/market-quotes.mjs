const sources = [
    { id: 'cedears', url: 'https://data912.com/live/arg_cedears', title: 'Data912 · CEDEARs', link: 'https://data912.com/' },
    { id: 'dollars', url: 'https://dolarapi.com/v1/dolares', title: 'DolarAPI · dólar', link: 'https://dolarapi.com/' },
    { id: 'crypto', url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_last_updated_at=true', title: 'CoinGecko · criptomonedas', link: 'https://www.coingecko.com/' },
];

export async function marketQuotes(messages, assets) {
    const context = [...messages.map(m => m.content), ...(Array.isArray(assets) ? assets : [])].join(' ').toUpperCase();
    const ids = new Set(['SPY', 'QQQ', 'DIA', 'IWM', 'EEM', 'EWZ']);
    for (const token of context.match(/\b[A-Z0-9]{2,8}\b/g) ?? []) ids.add(token);
    const results = await Promise.allSettled(sources.map(async source => {
        const response = await fetch(source.url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('source unavailable');
        return { source, data: await response.json() };
    }));
    const lines = [], citations = [];
    for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const { source, data } = result.value;
        let rows = [];
        if (source.id === 'cedears' && Array.isArray(data)) rows = data.filter(r => typeof r.symbol === 'string' && ids.has(r.symbol.toUpperCase()) && typeof r.c === 'number' && Number.isFinite(r.c) && r.c > 0).slice(0, 25).map(r => `${r.symbol.toUpperCase()}: ${r.c} ARS por CEDEAR (fecha de cotización no informada)`);
        if (source.id === 'dollars' && Array.isArray(data)) rows = data.filter(r => ['oficial', 'blue', 'bolsa', 'contadoconliqui'].includes(r.casa) && typeof r.venta === 'number' && Number.isFinite(r.venta) && r.venta > 0).map(r => `Dólar ${r.casa}: ${r.venta} ARS venta (actualización: ${typeof r.fechaActualizacion === 'string' && Number.isFinite(Date.parse(r.fechaActualizacion)) ? new Date(r.fechaActualizacion).toISOString() : 'no informada'})`);
        if (source.id === 'crypto' && data && typeof data === 'object') rows = ['bitcoin', 'ethereum', 'solana'].flatMap(id => { const item = data[id]; return item && typeof item.usd === 'number' && Number.isFinite(item.usd) && item.usd > 0 ? [`${id}: ${item.usd} USD (actualización: ${Number.isFinite(item.last_updated_at) && item.last_updated_at > 0 && item.last_updated_at < 4102444800 ? new Date(item.last_updated_at * 1000).toISOString() : 'no informada'})`] : []; });
        if (rows.length) { lines.push(`${source.title}:\n${rows.join('\n')}`); citations.push({ title: source.title, url: source.link }); }
    }
    return { context: lines.join('\n'), citations };
}
