const RATIOS_URL = 'https://ferminrp.github.io/google-sheets-argento/api/cedears.json';

export async function portfolioDividends(portfolio, apiKey, fetcher = fetch) {
    if (!apiKey) return { configured: false, items: [] };
    const positions = portfolio.investments.filter(item => item.kind === 'cedear' && item.coin && item.units > 0);
    if (!positions.length) return { configured: true, items: [] };
    const response = await fetcher(RATIOS_URL, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Ratios unavailable');
    const ratios = await response.json();
    if (!Array.isArray(ratios.items)) throw new Error('Invalid ratios');
    const today = new Date().toISOString().slice(0, 10);
    const items = await Promise.all(positions.map(async position => {
        const entry = ratios.items.find(row => String(row.Cedears).toUpperCase() === position.coin.toUpperCase());
        const ratio = Number(entry?.Ratio);
        const symbol = entry?.TickerOriginal;
        const base = { id: position.id, name: position.name, ticker: position.coin, units: position.units, purchaseDate: position.date };
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
