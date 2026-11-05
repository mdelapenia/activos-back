import { readPortfolio } from './portfolio.mjs';
import { portfolioDividends } from './dividends.mjs';
import { loadPriceQuotes } from './push.mjs';
import { stockQuotes } from './stock-quotes.mjs';
import { walletAddresses, walletHoldings } from './wallets.mjs';

const aliases = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', usdc: 'usd-coin', usdt: 'tether', bnb: 'binancecoin' };
const names = { crypto: 'Cripto', stock: 'Acciones', cedear: 'CEDEARs', 'arg-stock': 'Acciones argentinas', bond: 'Bonos', fund: 'Fondos', rate: 'Con tasa' };
const money = (amount, currency) => Number.isFinite(amount) ? new Intl.NumberFormat('es-AR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount) : 'No disponible';
const number = value => Number.isFinite(value) ? new Intl.NumberFormat('es-AR', { maximumSignificantDigits: 10 }).format(value) : 'No disponible';
const today = now => new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
const HELP = '🛟 Comandos disponibles:\n/menu — botones principales\n/cartera — valor, costo y rendimiento\n/activos — posiciones de tu cartera (usá /activos 2 para más)\n/activo SOL — detalle de un activo\n/precio BTC — consultar cotización\n/wallets — direcciones y saldos\n/distribucion — cartera por tipo\n/grafico distribucion — gráfico de cartera\n/grafico BTC — evolución de un activo\n/alza — abrir Alza\n/dividendos — próximos pagos estimados\n/alertas — alertas y canales\n/dolar — cotizaciones disponibles\n/ayuda — ver esta lista';

async function dollarRates(fetcher) {
    const response = await fetcher('https://dolarapi.com/v1/dolares', { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('No se pudieron consultar las cotizaciones del dólar.');
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('No se pudieron consultar las cotizaciones del dólar.');
    return data.filter(row => typeof row?.casa === 'string' && Number.isFinite(row?.venta) && row.venta > 0);
}
async function fxRate(fetcher) {
    try {
        const response = await fetcher('https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=ars', { signal: AbortSignal.timeout(12000) });
        if (response.ok) { const data = await response.json(); if (Number.isFinite(data?.['usd-coin']?.ars) && data['usd-coin'].ars > 0) return { value: data['usd-coin'].ars, source: 'USDC/ARS' }; }
    } catch { /* Try MEP. */ }
    try { const mep = (await dollarRates(fetcher)).find(row => row.casa === 'bolsa'); if (mep) return { value: mep.venta, source: 'dólar MEP' }; } catch { /* No conversion. */ }
    return null;
}

function rateValue(item, now) {
    const start = Date.parse(`${item.date}T00:00:00Z`), end = Date.parse(`${today(now)}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
    const rate = item.rate / 100;
    if (item.maturityDate) { const maturity = Date.parse(`${item.maturityDate}T00:00:00Z`); return item.amount * (1 + rate * Math.max(0, (Math.min(end, maturity) - start) / 86400000) / 365); }
    const monthly = item.period === 'month' ? rate : Math.pow(1 + rate, 1 / 12) - 1;
    return item.amount * Math.pow(1 + monthly, (now - start) / (365.25 / 12 * 86400000));
}
const quoteCurrency = item => ['cedear', 'arg-stock', 'bond', 'fund'].includes(item.kind) ? 'ARS' : 'USD';
export function convert(value, from, to, fx) { return !Number.isFinite(value) ? NaN : from === to ? value : !fx ? NaN : from === 'USD' ? value * fx.value : value / fx.value; }
function position(item, quotes, fx, now) {
    const currency = quoteCurrency(item), quote = quotes[`${item.kind}:${item.coin}`];
    const current = item.kind === 'rate' ? rateValue(item, now) : Number.isFinite(quote) && Number.isFinite(item.units) ? item.units * quote : NaN;
    const value = convert(current, item.kind === 'rate' ? item.currency : currency, item.currency, fx);
    const cost = item.costUnknown ? NaN : item.amount;
    const result = Number.isFinite(value) && Number.isFinite(cost) ? value - cost : NaN;
    return { ...item, quote, quoteCurrency: currency, value, result, percent: cost > 0 && Number.isFinite(result) ? result / cost * 100 : NaN };
}
export async function priced(items, fetcher, now, dependencies) {
    const wanted = items.filter(i => i.kind !== 'rate' && i.coin).map(i => ({ assetKind: i.kind, assetId: i.coin }));
    const stocks = [...new Set(items.filter(i => i.kind === 'stock' && i.coin).map(i => i.coin.toUpperCase()))];
    const [quotesResult, stockResult, fxResult] = await Promise.allSettled([dependencies.quotes(wanted, fetcher), dependencies.stocks(stocks, fetcher), dependencies.fx(fetcher)]);
    const quotes = quotesResult.status === 'fulfilled' ? quotesResult.value : {};
    if (stockResult.status === 'fulfilled') for (const [ticker, price] of Object.entries(stockResult.value)) quotes[`stock:${ticker}`] = price;
    const fx = fxResult.status === 'fulfilled' ? fxResult.value : null;
    return { rows: items.map(i => position(i, quotes, fx, now)), fx };
}
function detail(row) {
    const result = Number.isFinite(row.result) ? `${money(row.result, row.currency)} (${row.percent >= 0 ? '+' : ''}${number(row.percent)}%)` : 'No disponible';
    const unitCost = row.costUnknown || !(row.units > 0) ? NaN : row.amount / row.units;
    return `${row.name}${row.coin ? ` (${row.coin})` : ''} · ${names[row.kind] || row.kind}\nCantidad: ${row.units == null ? 'No aplica' : number(row.units)}\nPrecio actual: ${row.kind === 'rate' ? 'No aplica' : money(row.quote, row.quoteCurrency)}\nPrecio de compra: ${money(unitCost, row.currency)}\nValor actual: ${money(row.value, row.currency)}\nResultado: ${result}`;
}
export function findAssets(items, query) {
    const q = query.trim().replace(/^['"]|['"]$/g, '').replace(/^\$+/, '').toLowerCase(); if (!q) return [];
    const alias = aliases[q] || q;
    const exact = items.filter(i => (i.coin || '').toLowerCase() === alias || i.name.toLowerCase() === q);
    return exact.length ? exact : items.filter(i => i.name.toLowerCase().includes(q) || (i.coin || '').toLowerCase().includes(q));
}

export async function graphPositions(items, fetcher = fetch, now = Date.now()) {
    return priced(items, fetcher, now, { quotes: loadPriceQuotes, stocks: stockQuotes, fx: fxRate });
}

export async function telegramCommand(db, userId, command, argument, env, { fetcher = fetch, now = Date.now(), quotes = loadPriceQuotes, stocks = stockQuotes, fx = fxRate, dividends = portfolioDividends, wallets = walletAddresses, holdings = walletHoldings } = {}) {
    if (command === 'ayuda') return HELP;
    if (command === 'wallets') {
        const { wallets: saved } = await wallets(db, { _id: userId }, 'GET', null);
        if (!saved.length) return 'No tenés wallets guardadas. Agregá una en Configuración → Cuenta.';
        if (argument.trim() && !/^[1-9]\d{0,4}$/.test(argument.trim())) return 'Usá /wallets o indicá una página, por ejemplo /wallets 2.';
        const page = Number(argument.trim() || '1'), pages = Math.ceil(saved.length / 5);
        if (page > pages) return `Esa página no existe. Hay ${pages} ${pages === 1 ? 'página' : 'páginas'}.`;
        const selected = saved.slice((page - 1) * 5, page * 5);
        const results = await Promise.allSettled(selected.map(wallet => holdings(db, { _id: userId }, wallet.id, fetcher)));
        const lines = selected.map((wallet, index) => {
            const result = results[index];
            const header = `${wallet.label || 'Wallet'} · ${wallet.network}\n${wallet.address}`;
            if (result.status !== 'fulfilled') return `${header}\nNo se pudo consultar el saldo de esta red.`;
            const list = result.value.holdings;
            if (!list.length) return `${header}\nSin saldos detectados.`;
            return `${header}\n${list.slice(0, 15).map(item => `${item.name}${item.symbol ? ` (${item.symbol})` : ''}: ${number(item.units)}${item.key !== 'native' ? ` · contrato ${item.key}` : ''}`).join('\n')}${list.length > 15 || result.value.truncated ? '\nLa lista de tokens está incompleta; revisá la wallet.' : ''}`;
        });
        return `💳 Tus wallets (${saved.length}) · página ${page}/${pages}\n\n${lines.join('\n\n')}${page < pages ? `\n\nMás wallets: /wallets ${page + 1}` : ''}`;
    }
    if (command === 'dolar') {
        try { const rows = await dollarRates(fetcher); return rows.length ? `💵 Cotizaciones del dólar (ARS)\n${rows.map(r => `${r.nombre || r.casa}: compra ${money(r.compra, 'ARS')} · venta ${money(r.venta, 'ARS')}`).join('\n')}\nFuente: DolarAPI.` : 'No hay cotizaciones disponibles.'; }
        catch { return 'No se pudieron consultar los dólares. Intentá nuevamente.'; }
    }
    const { portfolio } = await readPortfolio(db, userId);
    const items = portfolio.investments || [];
    if (command === 'precio') {
        const term = argument.trim().replace(/^\$/, '').toLowerCase();
        if (!term) return 'Indicá un activo, por ejemplo: /precio BTC';
        if (!/^[a-z0-9][a-z0-9.~-]{0,149}$/.test(term)) return 'Ingresá un ticker o identificador válido, por ejemplo /precio BTC.';
        const matches = findAssets(items, term).filter(item => item.kind !== 'rate' && ((item.coin || '').toLowerCase() === (aliases[term] || term) || item.name.toLowerCase() === term));
        const choices = matches.length ? matches.map(item => ({ kind: item.kind, coin: item.coin, name: item.name })) : aliases[term] ? [{ kind: 'crypto', coin: aliases[term], name: aliases[term] }] : [{ kind: 'crypto', coin: term, name: term }, ...(/^[a-z0-9][a-z0-9.-]{0,14}$/.test(term) ? [{ kind: 'stock', coin: term.toUpperCase(), name: term.toUpperCase() }] : [])];
        const unique = [...new Map(choices.map(item => [`${item.kind}:${item.coin}`, item])).values()];
        const [prices, stockPrices] = await Promise.allSettled([quotes(unique.map(item => ({ assetKind: item.kind, assetId: item.coin })), fetcher), stocks(unique.filter(item => item.kind === 'stock').map(item => item.coin.toUpperCase()), fetcher)]);
        const values = prices.status === 'fulfilled' ? prices.value : {};
        if (stockPrices.status === 'fulfilled') for (const [id, value] of Object.entries(stockPrices.value)) values[`stock:${id}`] = value;
        const lines = unique.flatMap(item => { const price = values[`${item.kind}:${item.coin}`]; return Number.isFinite(price) && price > 0 ? [`${item.name} · ${names[item.kind] || item.kind}: ${money(price, quoteCurrency(item))}`] : []; });
        return lines.length ? `💱 Cotización\n${lines.join('\n')}\nLos precios pueden estar demorados.` : 'No encontré una cotización disponible. Probá con el ID de CoinGecko o un ticker de tu cartera.';
    }
    if (command === 'alertas') {
        const alerts = portfolio.alerts || [];
        if (!alerts.length) return 'No tenés alertas configuradas.';
        if (argument.trim() && !/^[1-9]\d{0,4}$/.test(argument.trim())) return 'Usá /alertas o indicá una página, por ejemplo /alertas 2.';
        const page = Number(argument.trim() || '1'), pages = Math.ceil(alerts.length / 30);
        if (page > pages) return `Esa página no existe. Hay ${pages} ${pages === 1 ? 'página' : 'páginas'}.`;
        return `🔔 Tus alertas (${alerts.length}) · página ${page}/${pages}\n${alerts.slice((page - 1) * 30, page * 30).map(a => `${a.assetName} · ${a.kind} · ${a.direction === 'below' ? '≤' : '≥'} ${number(a.threshold)}${['dividend', 'maturity'].includes(a.kind) ? ' días' : ''} · ${a.channels === 'push' ? 'push' : a.channels === 'telegram' ? 'Telegram' : 'push y Telegram'}${!['price', 'dividend'].includes(a.kind) ? ' (seguimiento en la app)' : ''}`).join('\n')}${page < pages ? `\nMás alertas: /alertas ${page + 1}` : ''}`;
    }
    if (command === 'dividendos') {
        if (!env.MASSIVE_API_KEY) return 'El proveedor de dividendos no está configurado.';
        try {
            const data = await dividends(portfolio, env.MASSIVE_API_KEY, fetcher, now);
            if (!data.configured) return 'No se pudo consultar el proveedor de dividendos.';
            const events = (data.items || []).flatMap(item => (item.events || []).filter(event => event.eligible && event.payDate >= today(now)).map(event => ({ ...event, name: item.ticker })) ).sort((a, b) => a.payDate.localeCompare(b.payDate));
            const incomplete = (data.items || []).some(item => item.status !== 'ok');
            if (!events.length) return `No se encontraron próximos dividendos elegibles.${incomplete ? ' Algunas posiciones no se pudieron consultar.' : ''}`;
            if (argument.trim() && !/^[1-9]\d{0,4}$/.test(argument.trim())) return 'Usá /dividendos o indicá una página, por ejemplo /dividendos 2.';
            const page = Number(argument.trim() || '1'), pages = Math.ceil(events.length / 30);
            if (page > pages) return `Esa página no existe. Hay ${pages} ${pages === 1 ? 'página' : 'páginas'}.`;
            return `📆 Próximos dividendos · página ${page}/${pages}\n${events.slice((page - 1) * 30, page * 30).map(e => `${e.payDate} · ${e.name} · ${money(e.estimatedGross, 'USD')} brutos${e.estimated ? ' (estimado)' : ''}`).join('\n')}${page < pages ? `\nMás pagos: /dividendos ${page + 1}` : ''}${incomplete ? '\nAlgunas posiciones no se pudieron consultar.' : ''}`;
        } catch { return 'No se pudieron consultar los dividendos. Intentá nuevamente.'; }
    }
    if (command === 'activo' && !argument.trim()) return 'Indicá el activo, por ejemplo: /activo SOL';
    let selected = command === 'activo' ? findAssets(items, argument) : items;
    if (!selected.length) return command === 'activo' ? 'No encontré ese activo en tu cartera.' : 'Tu cartera está vacía.';
    const totalPositions = selected.length;
    let page = 1, pages = 1;
    if (command === 'activos') {
        if (argument.trim() && !/^[1-9]\d{0,4}$/.test(argument.trim())) return 'Usá /activos o indicá una página, por ejemplo /activos 2.';
        page = Number(argument.trim() || '1'); pages = Math.ceil(selected.length / 25);
        if (page > pages) return `Esa página no existe. Hay ${pages} ${pages === 1 ? 'página' : 'páginas'}.`;
        selected = selected.slice((page - 1) * 25, page * 25);
    }
    const { rows, fx: exchange } = await priced(selected, fetcher, now, { quotes, stocks, fx });
    if (command === 'activo') return `🔍 Detalle de activo\n\n${rows.slice(0, 20).map(detail).join('\n\n')}${rows.length > 20 ? '\nSe muestran las primeras 20 posiciones.' : ''}`;
    if (command === 'activos') return `💸 Tus activos (${totalPositions}) · página ${page}/${pages}\n\n${rows.map(detail).join('\n\n')}${page < pages ? `\n\nMás posiciones: /activos ${page + 1}` : ''}`;
    const currency = portfolio.preferences?.display === 'ARS' ? 'ARS' : 'USD';
    const values = rows.map(row => convert(row.value, row.currency, currency, exchange));
    if (command === 'distribucion') {
        const groups = new Map(); rows.forEach((row, index) => { const group = groups.get(row.kind) || []; group.push(values[index]); groups.set(row.kind, group); });
        const lines = [...groups].map(([kind, amounts]) => `${names[kind] || kind}: ${amounts.every(Number.isFinite) ? money(amounts.reduce((a, b) => a + b, 0), currency) : 'No disponible (faltan precios o conversión)'}`);
        return `🎛️ Distribución (${currency})\n${lines.join('\n')}${exchange ? `\nConversión: ${exchange.source}.` : ''}`;
    }
    if (command === 'cartera') {
        const allValues = values.every(Number.isFinite), hasCost = rows.every(row => !row.costUnknown);
        const costs = rows.map(row => convert(row.amount, row.currency, currency, exchange));
        const total = allValues ? values.reduce((a, b) => a + b, 0) : NaN;
        const cost = hasCost && costs.every(Number.isFinite) ? costs.reduce((a, b) => a + b, 0) : NaN;
        const result = Number.isFinite(total) && Number.isFinite(cost) ? total - cost : NaN;
        return `📊 Tu cartera (${currency})\nValor actual: ${money(total, currency)}\nMonto invertido: ${money(cost, currency)}\nResultado: ${Number.isFinite(result) ? `${money(result, currency)} (${result >= 0 ? '+' : ''}${number(cost > 0 ? result / cost * 100 : NaN)}%)` : 'No disponible'}${!allValues ? '\nFaltan cotizaciones o conversiones para calcular el total.' : ''}${!hasCost ? '\nHay posiciones con costo desconocido.' : ''}${exchange ? `\nConversión: ${exchange.source}.` : ''}`;
    }
    return HELP;
}
