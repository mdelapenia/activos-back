const RATIOS_URL = 'https://ferminrp.github.io/google-sheets-argento/api/cedears.json';

export async function portfolioDividends(portfolio, apiKey, fetcher = fetch) {
    if (!apiKey) return { configured: false, items: [] };
    const positions = portfolio.investments.filter(item => (item.kind === 'cedear' || item.kind === 'stock') && item.coin && item.units > 0);
    if (!positions.length) return { configured: true, items: [] };
    let ratios = { items: [] };
    if (positions.some(position => position.kind === 'cedear')) {
        try {
            const response = await fetcher(RATIOS_URL, { signal: AbortSignal.timeout(15000) });
            if (response.ok) { const data = await response.json(); if (Array.isArray(data.items)) ratios = data; }
        } catch { /* Las acciones no dependen de los ratios de CEDEAR. */ }
    }
    const today = new Date().toISOString().slice(0, 10);
    const items = await Promise.all(positions.map(async position => {
        const entry = ratios.items.find(row => String(row.Cedears).toUpperCase() === position.coin.toUpperCase());
        const ratio = position.kind === 'stock' ? 1 : Number(entry?.Ratio);
        const symbol = position.kind === 'stock' ? position.coin.toUpperCase() : entry?.TickerOriginal;
        const base = { id: position.id, name: position.name, ticker: position.coin, kind: position.kind, units: position.units, purchaseDate: position.date };
        if (!Number.isFinite(ratio) || ratio <= 0 || typeof symbol !== 'string' || !/^[A-Za-z0-9.-]{1,20}$/.test(symbol)) return { ...base, status: 'missing_ratio' };
        try {
            const url = new URL('https://api.massive.com/stocks/v1/dividends');
            url.searchParams.set('ticker', symbol);
            url.searchParams.set('limit', '100');
            url.searchParams.set('sort', 'ex_dividend_date.desc');
            url.searchParams.set('apiKey', apiKey);
            const result = await fetcher(url, { signal: AbortSignal.timeout(15000) });
            if (!result.ok) throw new Error('Provider unavailable');
            const data = await result.json();
            if (!Array.isArray(data.results)) throw new Error('Invalid response');
            const events = data.results.filter(event => typeof event.pay_date === 'string' && event.pay_date >= today && typeof event.ex_dividend_date === 'string' && typeof event.cash_amount === 'number' && event.cash_amount > 0 && event.currency === 'USD')
                .sort((a, b) => a.pay_date.localeCompare(b.pay_date))
                .map(event => ({ payDate: event.pay_date, exDate: event.ex_dividend_date, amountPerShare: event.cash_amount, eligible: position.date < event.ex_dividend_date, estimatedGross: position.units / ratio * event.cash_amount }));
            return { ...base, status: 'ok', ratio, symbol, events };
        } catch { return { ...base, status: 'unavailable' }; }
    }));
    return { configured: true, items };
}

// Massive cubre principalmente valores de EE. UU.; no representa todas las bolsas del mundo.
export async function marketDividends(apiKey, fetcher = fetch, now = Date.now()) {
    if (!apiKey) return { configured: false, items: [], truncated: false };
    const today = new Date(now);
    const end = new Date(now + 28 * 86400000).toISOString().slice(0, 10);
    const start = today.toISOString().slice(0, 10);
    let url = new URL('https://api.massive.com/v3/reference/dividends');
    url.searchParams.set('pay_date.gte', start);
    url.searchParams.set('pay_date.lte', end);
    url.searchParams.set('limit', '1000');
    url.searchParams.set('sort', 'pay_date');
    url.searchParams.set('order', 'asc');
    const items = [];
    let pages = 0;
    while (url && pages++ < 10) {
        url.searchParams.set('apiKey', apiKey);
        const response = await fetcher(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('Dividend provider unavailable');
        const data = await response.json();
        if (data.results != null && !Array.isArray(data.results)) throw new Error('Invalid dividend response');
        if (!Array.isArray(data.results) && data.status !== 'OK') throw new Error('Invalid dividend response');
        for (const event of data.results ?? []) {
            if (typeof event.ticker !== 'string' || typeof event.pay_date !== 'string' || event.pay_date < start || event.pay_date > end || typeof event.cash_amount !== 'number' || !Number.isFinite(event.cash_amount) || event.cash_amount <= 0) continue;
            items.push({ ticker: event.ticker, payDate: event.pay_date, exDate: typeof event.ex_dividend_date === 'string' ? event.ex_dividend_date : null, amountPerShare: event.cash_amount, currency: typeof event.currency === 'string' ? event.currency : null });
        }
        if (data.next_url) {
            const next = new URL(data.next_url);
            if (!['api.massive.com', 'api.polygon.io'].includes(next.hostname) || next.protocol !== 'https:' || !next.pathname.startsWith('/v3/reference/dividends')) throw new Error('Invalid pagination URL');
            next.hostname = 'api.massive.com';
            url = next;
        } else url = null;
    }
    items.sort((a, b) => a.payDate.localeCompare(b.payDate) || a.ticker.localeCompare(b.ticker));
    return { configured: true, items, truncated: Boolean(url), start, end };
}
