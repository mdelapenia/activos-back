export async function earningsCalendar(date, fetcher = fetch) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Invalid date');
    const url = new URL('https://api.nasdaq.com/api/calendar/earnings');
    url.searchParams.set('date', date);
    const response = await fetcher(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Earnings provider unavailable');
    const data = await response.json();
    if (!data?.data || (data.data.rows != null && !Array.isArray(data.data.rows))) throw new Error('Invalid earnings response');
    return { date, items: (data.data.rows ?? []).flatMap(row => typeof row.symbol === 'string' && typeof row.name === 'string' ? [{ ticker: row.symbol, name: row.name, time: row.time === 'time-pre-market' ? 'Antes de la apertura' : row.time === 'time-after-hours' ? 'Después del cierre' : 'Horario no informado' }] : []) };
}
