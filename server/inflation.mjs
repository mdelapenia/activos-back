export function inflationFromBls(payload) {
    if (payload?.status !== 'REQUEST_SUCCEEDED') throw new Error('BLS no devolvió datos válidos.');
    const observations = payload.Results?.series?.find(series => series.seriesID === 'CUUR0000SA0')?.data;
    if (!Array.isArray(observations)) throw new Error('BLS no devolvió la serie solicitada.');
    const index = new Map();
    for (const row of observations) {
        if (!/^\d{4}$/.test(row.year) || !/^M(0[1-9]|1[0-2])$/.test(row.period)) continue;
        const value = Number(row.value);
        if (Number.isFinite(value) && value > 0) index.set(`${row.year}-${row.period.slice(1)}`, value);
    }
    const monthly = [], yearly = [];
    for (const [date, value] of index) {
        const [year, month] = date.split('-').map(Number);
        const previous = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
        const priorYear = `${year - 1}-${String(month).padStart(2, '0')}`;
        if (index.has(previous)) monthly.push({ fecha: `${date}-01`, valor: (value / index.get(previous) - 1) * 100 });
        if (index.has(priorYear)) yearly.push({ fecha: `${date}-01`, valor: (value / index.get(priorYear) - 1) * 100 });
    }
    monthly.sort((a, b) => b.fecha.localeCompare(a.fecha));
    yearly.sort((a, b) => b.fecha.localeCompare(a.fecha));
    if (!monthly.length || !yearly.length) throw new Error('BLS no devolvió suficientes datos.');
    return { monthly, yearly, errors: [] };
}

let cached;
export async function usInflation(now = Date.now()) {
    if (cached && now - cached.time < 3 * 60 * 60 * 1000) return cached.data;
    const year = new Date(now).getUTCFullYear();
    const response = await fetch('https://api.bls.gov/publicAPI/v1/timeseries/data/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesid: ['CUUR0000SA0'], startyear: String(year - 6), endyear: String(year) }),
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('No se pudo consultar BLS.');
    const data = inflationFromBls(await response.json());
    cached = { time: now, data };
    return data;
}
