import { createCanvas } from '@napi-rs/canvas';
import { readPortfolio } from './portfolio.mjs';
import { convert, graphPositions } from './telegram-commands.mjs';

const labels = { crypto: 'Cripto', stock: 'Acciones', cedear: 'CEDEARs', 'arg-stock': 'Acciones argentinas', bond: 'Bonos', fund: 'Fondos', rate: 'Con tasa' };
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
export async function telegramGraph(db, userId, argument, { fetcher = fetch, now = Date.now(), positions = graphPositions } = {}) {
    const query = argument.trim();
    if (!/^distribuci[oó]n$/i.test(query)) return { error: 'Para ver la distribución escribí /grafico distribucion.' };
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
    return { error: 'Para ver la distribución escribí /grafico distribucion.' };
}
