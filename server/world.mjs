// Clima mundial: indicadores de mercado que resumen miedo (VIX), energía (petróleo),
// refugio (oro) y tasas de EE.UU. El S&P 500 se devuelve completo porque el front lo usa
// para medir cómo reaccionó cada activo en crisis pasadas.
const DAY = 86400000;
const CACHE_MS = 30 * 60 * 1000;
const SYMBOLS = { sp500: '^GSPC', vix: '^VIX', oil: 'CL=F', gold: 'GC=F', us10y: '^TNX', us3m: '^IRX' };

async function series(symbol, fetcher) {
    const response = await fetcher(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1d`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Indicador no disponible.');
    const result = (await response.json())?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close;
    if (result?.meta?.symbol?.toUpperCase() !== symbol || !Array.isArray(result.timestamp) || !Array.isArray(closes)) throw new Error('Indicador inválido.');
    const points = result.timestamp.flatMap((time, i) => Number.isFinite(time) && Number.isFinite(closes[i]) && closes[i] > 0 ? [{ time: time * 1000, price: closes[i] }] : []);
    if (points.length < 2) throw new Error('Indicador sin datos.');
    return points;
}

const round = (value, digits = 2) => Number(value.toFixed(digits));

// Resumen compacto: último valor, valor de hace ~3 meses, extremos de 52 semanas y mediana de 10 años.
export function indicator(points) {
    const last = points[points.length - 1];
    const before = [...points].reverse().find(point => point.time <= last.time - 91 * DAY) ?? points[0];
    const year = points.filter(point => point.time >= last.time - 365 * DAY).map(point => point.price);
    const sorted = points.map(point => point.price).sort((a, b) => a - b);
    return { last: round(last.price), time: last.time, prev3m: round(before.price), high52w: round(Math.max(...year)), low52w: round(Math.min(...year)), median: round(sorted[Math.floor(sorted.length / 2)]) };
}

export function worldClimateSource(fetcher = fetch) {
    let cache = null;
    return async function worldClimate(now = Date.now()) {
        if (cache && now - cache.time < CACHE_MS) return cache.data;
        const names = Object.keys(SYMBOLS);
        const results = await Promise.allSettled(names.map(name => series(SYMBOLS[name], fetcher)));
        const found = Object.fromEntries(names.flatMap((name, i) => results[i].status === 'fulfilled' ? [[name, results[i].value]] : []));
        // Sin el S&P 500 no hay referencia de mercado: se informa el error en lugar de datos parciales.
        if (!found.sp500) throw new Error('No se pudo consultar el S&P 500.');
        const data = {
            updatedAt: now,
            // [día desde 1970, cierre] para no enviar 2.500 objetos.
            sp500: found.sp500.map(point => [Math.round(point.time / DAY), round(point.price)]),
            indicators: Object.fromEntries(names.map(name => [name, found[name] ? indicator(found[name]) : null])),
        };
        cache = { time: now, data };
        return data;
    };
}

export const worldClimate = worldClimateSource();
