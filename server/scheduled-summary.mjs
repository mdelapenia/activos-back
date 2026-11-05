import { createHash } from 'node:crypto';
import { HttpError } from './security.mjs';
import { readPortfolio } from './portfolio.mjs';
import { portfolioDividends } from './dividends.mjs';
import { graphPositions, convert } from './telegram-commands.mjs';
import { isQuietHours, sendPush } from './push.mjs';
import { sendTelegram } from './telegram.mjs';

const DEFAULT = { enabled: false, frequency: 'daily', time: '09:00', day: 1, channels: 'both' };
const hash = value => createHash('sha256').update(value).digest('hex');
const money = (value, currency) => new Intl.NumberFormat('es-AR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);

export async function summarySettings(db, user, data, now = Date.now()) {
    const collection = db.collection('scheduled_summaries');
    if (data !== null) {
        if (!data || typeof data.enabled !== 'boolean' || !['daily', 'weekly'].includes(data.frequency) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time) || !Number.isInteger(data.day) || data.day < 0 || data.day > 6 || !['push', 'telegram', 'both'].includes(data.channels)) throw new HttpError(400, 'Revisá la frecuencia, el horario y el canal del resumen.');
        const settings = { enabled: data.enabled, frequency: data.frequency, time: data.time, day: data.day, channels: data.channels, enabledAt: new Date(now) };
        await collection.updateOne({ _id: user._id }, { $set: settings }, { upsert: true });
        return { settings: { enabled: settings.enabled, frequency: settings.frequency, time: settings.time, day: settings.day, channels: settings.channels } };
    }
    const row = await collection.findOne({ _id: user._id });
    return { settings: row ? { enabled: row.enabled, frequency: row.frequency, time: row.time, day: row.day, channels: row.channels } : DEFAULT };
}

// Returns the most recent scheduled instant in Argentina and its local calendar date.
export function summarySlot(settings, now) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(part => [part.type, part.value]));
    const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
    let daysBack = settings.frequency === 'weekly' ? (date.getUTCDay() - settings.day + 7) % 7 : 0;
    if (daysBack === 0 && `${parts.hour}:${parts.minute}` < settings.time) daysBack = settings.frequency === 'weekly' ? 7 : 1;
    date.setUTCDate(date.getUTCDate() - daysBack);
    const slot = date.toISOString().slice(0, 10);
    return { slot, instant: Date.parse(`${slot}T${settings.time}:00-03:00`) };
}

export async function buildSummary(portfolio, env, now, { positions = graphPositions, dividends = portfolioDividends, fetcher = fetch } = {}) {
    const currency = portfolio.preferences?.display === 'ARS' ? 'ARS' : 'USD';
    const items = portfolio.investments || [];
    let total = null;
    if (items.length) {
        try { const { rows, fx } = await positions(items, fetcher, now); const amounts = rows.map(row => convert(row.value, row.currency, currency, fx)); if (amounts.every(Number.isFinite)) total = amounts.reduce((a, b) => a + b, 0); } catch { /* Report missing values. */ }
    } else total = 0;
    let payments = [], dividendNote = '';
    if (!env.MASSIVE_API_KEY) dividendNote = 'Dividendos: proveedor no configurado.';
    else try {
        const result = await dividends(portfolio, env.MASSIVE_API_KEY, fetcher, now);
        if (!result.configured) dividendNote = 'Dividendos: datos no disponibles.';
        else {
            const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
            payments = (result.items || []).flatMap(item => (item.events || []).filter(event => event.eligible && event.payDate >= today).map(event => ({ ...event, ticker: item.ticker }))).sort((a, b) => a.payDate.localeCompare(b.payDate)).slice(0, 3);
            dividendNote = (result.items || []).some(item => item.status !== 'ok') ? 'Algunos dividendos no están disponibles.' : '';
        }
    } catch { dividendNote = 'Dividendos: datos no disponibles.'; }
    return { currency, total, payments, dividendNote };
}

export async function checkScheduledSummaries(db, env, now = Date.now(), { build = buildSummary, sendWeb = sendPush, sendTg = sendTelegram } = {}) {
    const configs = await db.collection('scheduled_summaries').find({ enabled: true }).toArray();
    for (const config of configs) {
        try {
            const { slot, instant } = summarySlot(config, now);
            if (instant > now || instant < new Date(config.enabledAt).getTime()) continue;
            const user = await db.collection('users').findOne({ _id: config._id, disabled: { $ne: true } }, { projection: { _id: 1 } });
            if (!user) continue;
            const { portfolio } = await readPortfolio(db, user._id);
            if (isQuietHours(portfolio.preferences?.quietHours, now)) continue;
            const targets = [];
            if (config.channels !== 'telegram') targets.push(...(await db.collection('push_subscriptions').find({ userId: user._id }).toArray()).map(row => ({ type: 'push', row })));
            if (config.channels !== 'push' && env.TELEGRAM_BOT_TOKEN) { const row = await db.collection('telegram_subscriptions').findOne({ _id: user._id }); if (row) targets.push({ type: 'telegram', row }); }
            if (!targets.length) continue;
            const pending = [];
            for (const target of targets) {
                const id = hash(`summary:${user._id}:${config.frequency}:${slot}:${target.type}:${target.type === 'telegram' ? target.row.chatId : target.row._id}`);
                try { await db.collection('summary_deliveries').insertOne({ _id: id, createdAt: new Date(now) }); pending.push({ ...target, id }); }
                catch (error) { if (error.code !== 11000) throw error; }
            }
            if (!pending.length) continue;
            let summary;
            try { summary = await build(portfolio, env, now); }
            catch (error) { await Promise.all(pending.map(target => db.collection('summary_deliveries').deleteOne({ _id: target.id }))); throw error; }
            let previous;
            try { previous = await db.collection('summary_snapshots').find({ userId: user._id, frequency: config.frequency, currency: summary.currency, slot: { $lt: slot } }).sort({ slot: -1 }).limit(1).toArray(); }
            catch (error) { await Promise.all(pending.map(target => db.collection('summary_deliveries').deleteOne({ _id: target.id }))); throw error; }
            const change = summary.total != null && Number.isFinite(previous[0]?.total) ? summary.total - previous[0].total : null;
            const lines = [summary.total === null ? 'Valor de cartera: no disponible (faltan precios o conversión).' : `Valor de cartera: ${money(summary.total, summary.currency)}.`];
            lines.push(change === null ? 'Cambio desde el resumen anterior: no disponible.' : `Cambio desde ${previous[0].slot}: ${change >= 0 ? '+' : ''}${money(change, summary.currency)} (incluye aportes y retiros).`);
            if (summary.payments.length) lines.push(`Próximos dividendos: ${summary.payments.map(event => `${event.ticker} ${event.payDate}${Number.isFinite(event.estimatedGross) ? ` ${money(event.estimatedGross, 'USD')} brutos` : ''}${event.estimated ? ' estimado' : ''}`).join('; ')}.`);
            else if (!summary.dividendNote) lines.push('Sin próximos dividendos detectados.');
            if (summary.dividendNote) lines.push(summary.dividendNote);
            const payload = { title: `📊 Resumen ${config.frequency === 'daily' ? 'diario' : 'semanal'} de Alza`, body: lines.join('\n'), url: '/' };
            let delivered = false;
            for (const target of pending) {
                try { const success = await (target.type === 'push' ? sendWeb : sendTg)(db, target.row, payload, env); if (success === false) { await db.collection('summary_deliveries').deleteOne({ _id: target.id }); } else delivered = true; }
                catch { await db.collection('summary_deliveries').deleteOne({ _id: target.id }); }
            }
            if (delivered && summary.total !== null && Number.isFinite(summary.total)) await db.collection('summary_snapshots').updateOne({ _id: hash(`snapshot:${user._id}:${config.frequency}:${slot}`) }, { $setOnInsert: { userId: user._id, frequency: config.frequency, slot, currency: summary.currency, total: summary.total, createdAt: new Date(now) } }, { upsert: true });
        } catch (error) { console.error('No se pudo procesar un resumen programado:', error.message); }
    }
}
