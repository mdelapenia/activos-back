import { createCanvas } from '@napi-rs/canvas';
import { readPortfolio } from './portfolio.mjs';
import { stockHistory } from './stock-quotes.mjs';
import { convert, findAssets, graphPositions } from './telegram-commands.mjs';

const labels = { crypto: 'Cripto', stock: 'Acciones', cedear: 'CEDEARs', 'arg-stock': 'Acciones argentinas', bond: 'Bonos', fund: 'Fondos', rate: 'Con tasa' };
const aliases = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', usdt: 'tether', usdc: 'usd-coin', bnb: 'binancecoin' };
const colors = ['#83d8ab', '#93baff', '#e0b677', '#d1a2d7', '#91c9cf', '#e59387', '#ccd393'];
const WIDTH = 1100, HEIGHT = 700;
const fmt = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: n < 1 ? 6 : 2 }).format(n);
function canvas(title, subtitle) {
    const image = createCanvas(WIDTH, HEIGHT), ctx = image.getContext('2d');
    ctx.fillStyle = '#101816'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = '#89dbb0'; ctx.font = 'bold 22px sans-serif'; ctx.fillText('ALZA  ·  TELEGRAM', 65, 65);
    ctx.fillStyle = '#f1f4f1'; ctx.font = 'bold 42px sans-serif'; ctx.fillText(title.slice(0, 42), 65, 125);
    ctx.fillStyle = '#a6b8ae'; ctx.font = '22px sans-serif'; ctx.fillText(subtitle.slice(0, 95), 65, 166);
    return { image, ctx };
}
export async function telegramGraph(db, userId, argument, { fetcher = fetch, now = Date.now(), positions = graphPositions, history = stockHistory } = {}) {
    const query = argument.trim();
    if (!query) return { error: 'Para ver la distribución escribí /grafico distribucion. Para un activo, /grafico BTC.' };
    const { portfolio } = await readPortfolio(db, userId);
    if (/^distribuci[oó]n$/i.test(query)) {
        if (!portfolio.investments.length) return { error: 'Tu cartera está vacía.' };
        const { rows, fx } = await positions(portfolio.investments, fetcher, now);
        const currency = portfolio.preferences?.display === 'ARS' ? 'ARS' : 'USD';
        const groups = new Map();
        for (const row of rows) { const value = convert(row.value, row.currency, currency, fx); if (!Number.isFinite(value) || value < 0) return { error: 'No se puede graficar la distribución completa: faltan cotizaciones o conversión.' }; groups.set(row.kind, (groups.get(row.kind) || 0) + value); }
        const data = [...groups].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
        const total = data.reduce((sum, [, value]) => sum + value, 0);
        if (!(total > 0)) return { error: 'No hay valores positivos disponibles para graficar.' };
        const { image, ctx } = canvas('Distribución de tu cartera', `Valor por tipo de activo · ${currency}`);
        let angle = -Math.PI / 2;
        data.forEach(([, value], i) => { const next = angle + value / total * 2 * Math.PI; ctx.beginPath(); ctx.arc(310, 420, 205, angle, next); ctx.lineTo(310, 420); ctx.closePath(); ctx.fillStyle = colors[i % colors.length]; ctx.fill(); angle = next; });
        ctx.beginPath(); ctx.arc(310, 420, 125, 0, Math.PI * 2); ctx.fillStyle = '#101816'; ctx.fill();
        data.forEach(([kind, value], i) => { const y = 240 + i * 61; ctx.fillStyle = colors[i % colors.length]; ctx.fillRect(590, y - 16, 18, 18); ctx.fillStyle = '#f1f4f1'; ctx.font = 'bold 22px sans-serif'; ctx.fillText(`${labels[kind] || kind} · ${fmt(value / total * 100)}%`, 625, y); ctx.fillStyle = '#a6b8ae'; ctx.font = '19px sans-serif'; ctx.fillText(`${currency} ${fmt(value)}`, 625, y + 25); });
        ctx.textAlign = 'center'; ctx.fillStyle = '#a6b8ae'; ctx.font = '20px sans-serif'; ctx.fillText('Total estimado', 310, 405); ctx.fillStyle = '#f1f4f1'; ctx.font = 'bold 24px sans-serif'; ctx.fillText(`${currency} ${fmt(total)}`, 310, 440); ctx.textAlign = 'left';
        return { png: image.toBuffer('image/png'), caption: `Distribución estimada en ${currency}. ${fx ? `Conversión: ${fx.source}.` : ''}` };
    }
    const qualified = query.match(/^(crypto|stock|cedear|arg-stock|bond|fund):(.+)$/i);
    const term = qualified ? qualified[2].trim() : query;
    const candidates = portfolio.investments.filter(item => item.kind !== 'rate' && item.coin && (!qualified || item.kind === qualified[1].toLowerCase()));
    const matches = findAssets(candidates, term);
    const unique = [...new Map(matches.map(item => [`${item.kind}:${item.coin}`, item])).values()];
    if (unique.length > 1) return { error: `Encontré más de un activo para ${query}. Especificá el tipo, por ejemplo /grafico cedear:AAPL o /grafico stock:AAPL.` };
    const alias = !qualified && aliases[term.toLowerCase()];
    const explicitKind = qualified?.[1].toLowerCase();
    const explicit = explicitKind && /^[a-z0-9][a-z0-9.-]{0,149}$/i.test(term) ? { kind: explicitKind, coin: explicitKind === 'crypto' ? term.toLowerCase() : term.toUpperCase(), name: term } : null;
    const ticker = !qualified && /^[A-Za-z][A-Za-z0-9.-]{0,14}$/.test(term) ? { kind: 'stock', coin: term.toUpperCase(), name: term.toUpperCase() } : null;
    const asset = unique[0] || (alias ? { kind: 'crypto', coin: alias, name: alias } : explicit || ticker);
    if (!asset) return { error: 'No encontré ese activo. Probá con un ticker, un activo de tu cartera o /grafico BTC.' };
    let points;
    try {
        if (asset.kind === 'stock') points = await history(asset.coin.toUpperCase(), fetcher);
        else {
            const marketPaths = { cedear: 'cedears', 'arg-stock': 'stocks', bond: 'bonds' };
            const url = asset.kind === 'crypto' ? `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(asset.coin)}/market_chart?vs_currency=usd&days=30` : marketPaths[asset.kind] ? `https://data912.com/historical/${marketPaths[asset.kind]}/${encodeURIComponent(asset.coin)}` : '';
            if (!url) return { error: 'Todavía no hay gráfico histórico para este tipo de activo.' };
            const response = await fetcher(url, { signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error('provider');
            const data = await response.json();
            const raw = asset.kind === 'crypto' ? data?.prices : data;
            if (!Array.isArray(raw)) throw new Error('invalid');
            points = raw.map(row => asset.kind === 'crypto' ? { time: Number(row[0]), price: Number(row[1]) } : { time: Date.parse(`${String(row.date).slice(0, 10)}T12:00:00Z`), price: Number(row.c) / (asset.kind === 'bond' ? 100 : 1) });
        }
    } catch { return { error: 'No se pudo consultar el historial de este activo. Intentá nuevamente.' }; }
    points = points.filter(point => Number.isFinite(point.time) && point.time >= now - 31 * 86400000 && point.time <= now && Number.isFinite(point.price) && point.price > 0).sort((a, b) => a.time - b.time);
    if (points.length < 2) return { error: 'No hay suficientes datos recientes para graficar este activo.' };
    const low = Math.min(...points.map(p => p.price)), high = Math.max(...points.map(p => p.price));
    const padding = (high - low || high * 0.02) * 0.1, min = low - padding, max = high + padding;
    const { image, ctx } = canvas(`Evolución · ${asset.name}`, `Últimos 30 días · ${['crypto', 'stock'].includes(asset.kind) ? 'USD' : 'ARS'} por unidad`);
    const unit = ['crypto', 'stock'].includes(asset.kind) ? 'USD' : 'ARS';
    const lastDate = new Date(points.at(-1).time).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
    ctx.fillStyle = '#f1f4f1'; ctx.font = 'bold 24px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`Último dato: ${unit} ${fmt(points.at(-1).price)} (${lastDate})`, 65, 208);
    const left = 130, right = 1030, top = 250, bottom = 550;
    for (let i = 0; i <= 4; i++) { const y = top + (bottom - top) * i / 4; ctx.strokeStyle = '#33443a'; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.fillStyle = '#a6b8ae'; ctx.font = '18px sans-serif'; ctx.textAlign = 'right'; ctx.fillText(fmt(max - (max - min) * i / 4), left - 14, y + 6); }
    ctx.strokeStyle = '#83d8ab'; ctx.lineWidth = 4; ctx.beginPath();
    points.forEach((point, i) => { const x = left + (point.time - points[0].time) / (points.at(-1).time - points[0].time || 1) * (right - left); const y = bottom - (point.price - min) / (max - min) * (bottom - top); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke();
    ctx.fillStyle = '#a6b8ae'; ctx.font = '18px sans-serif';
    for (let i = 0; i <= 4; i++) {
        const x = left + (right - left) * i / 4;
        const timestamp = points[0].time + (points.at(-1).time - points[0].time) * i / 4;
        ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
        ctx.fillText(new Date(timestamp).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' }), x, 585);
    }
    const samples = [points[0], points[Math.floor((points.length - 1) / 2)], points.at(-1)];
    samples.forEach((point, index) => {
        const x = left + (point.time - points[0].time) / (points.at(-1).time - points[0].time || 1) * (right - left);
        const y = bottom - (point.price - min) / (max - min) * (bottom - top);
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fillStyle = '#e8fff2'; ctx.fill();
        ctx.textAlign = index === 0 ? 'left' : index === 2 ? 'right' : 'center';
        ctx.fillStyle = '#a6b8ae'; ctx.font = '17px sans-serif';
        ctx.fillText(new Date(point.time).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', timeZone: 'UTC' }), x, 622);
        ctx.fillStyle = '#f1f4f1'; ctx.font = 'bold 20px sans-serif'; ctx.fillText(`${unit} ${fmt(point.price)}`, x, 648);
    });
    ctx.fillStyle = '#a6b8ae'; ctx.font = '17px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Las cotizaciones pueden estar demoradas.', 65, 685);
    return { png: image.toBuffer('image/png'), caption: `${asset.name} · últimos 30 días. Último dato: ${unit} ${fmt(points.at(-1).price)} (${lastDate}). Las cotizaciones pueden estar demoradas.` };
}
