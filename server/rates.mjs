// Radar de tasas: cauciones (ArgentinaDatos, fuente IOL) contra su propio historial y contra plazos fijos.
import { createHash } from 'node:crypto';
import { readPortfolio } from './portfolio.mjs';
import { deliverNotification, isQuietHours, notificationSubscriptions, receives } from './push.mjs';

const API = 'https://api.argentinadatos.com/v1/finanzas';
const digest = value => createHash('sha256').update(value).digest('hex');
const ZONE = 'America/Argentina/Buenos_Aires';
const round = value => Math.round(value * 100) / 100;

// Los plazos publicados cambian cada día; se agrupan para poder compararlos con días anteriores.
export const BUCKETS = [
    { id: 'd1', label: '1 a 3 días', min: 1, max: 3 },
    { id: 'w1', label: '1 semana', min: 4, max: 10 },
    { id: 'w2', label: '2 semanas', min: 11, max: 20 },
    { id: 'm1', label: '1 mes', min: 21, max: 45 },
];
const MIN_VOLUME = 10_000_000; // Operaciones chicas no son una tasa representativa.
const MIN_HISTORY_DAYS = 3;

export const argentinaDate = (now = Date.now()) => new Date(now).toLocaleDateString('en-CA', { timeZone: ZONE });

export function isMarketOpen(now = Date.now()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(part => [part.type, part.value]));
    if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
    const time = `${parts.hour}:${parts.minute}`;
    return time >= '10:30' && time <= '17:10';
}

async function getJson(url, fetcher) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Proveedor de tasas no disponible');
    return response.json();
}

export function parseCauciones(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.flatMap(row => {
        const plazo = Number(row?.plazo), tasa = Number(row?.tasaActual), monto = Number(row?.montoContado);
        const fecha = typeof row?.fechaOperacion === 'string' ? row.fechaOperacion.slice(0, 10) : '';
        if (!Number.isInteger(plazo) || plazo < 1 || plazo > 365 || !Number.isFinite(tasa) || tasa <= 0 || tasa > 5000 || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return [];
        const min = Number(row?.tasaMinDia), max = Number(row?.tasaMaxDia);
        return [{ plazo, tasa, monto: Number.isFinite(monto) && monto > 0 ? monto : 0, fecha, ...(Number.isFinite(min) && min > 0 ? { min } : {}), ...(Number.isFinite(max) && max > 0 ? { max } : {}) }];
    }).sort((a, b) => a.plazo - b.plazo);
}

export function parsePlazosFijos(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.flatMap(row => {
        // El proveedor publica la TNA como fracción (0.1925 = 19,25%).
        const tna = Number(row?.tnaClientes) * 100;
        const entidad = typeof row?.entidad === 'string' ? row.entidad.trim().slice(0, 80) : '';
        return entidad && Number.isFinite(tna) && tna > 0 && tna < 1000 ? [{ entidad, tna: round(tna) }] : [];
    }).sort((a, b) => b.tna - a.tna);
}

export async function fetchRates(fetcher = fetch) {
    const [cauciones, plazos] = await Promise.allSettled([getJson(`${API}/cauciones/ars`, fetcher), getJson(`${API}/tasas/plazoFijo`, fetcher)]);
    if (cauciones.status === 'rejected') throw cauciones.reason;
    return { cauciones: parseCauciones(cauciones.value), plazosFijos: plazos.status === 'fulfilled' ? parsePlazosFijos(plazos.value) : [] };
}

// Por grupo de plazo, la caución con más volumen operado es la referencia.
export function bucketRates(cauciones) {
    return BUCKETS.flatMap(bucket => {
        const rows = cauciones.filter(row => row.plazo >= bucket.min && row.plazo <= bucket.max && row.monto >= MIN_VOLUME);
        if (!rows.length) return [];
        const top = rows.reduce((best, row) => row.monto > best.monto ? row : best);
        return [{ bucket: bucket.id, label: bucket.label, plazo: top.plazo, tasa: top.tasa, monto: top.monto }];
    });
}

const median = values => { const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };

export async function recordRates(db, buckets, date, now = Date.now()) {
    const collection = db.collection('rate_history');
    for (const row of buckets) await collection.updateOne(
        { _id: `caucion-ars:${row.bucket}:${date}` },
        { $set: { instrument: 'caucion-ars', bucket: row.bucket, date, last: row.tasa, updatedAt: new Date(now) }, $max: { max: row.tasa }, $inc: { sum: row.tasa, count: 1 } },
        { upsert: true });
}

// Tasa habitual: mediana del promedio diario de las últimas ruedas, sin contar la de hoy.
export async function usualRates(db, date) {
    const rows = await db.collection('rate_history').find({ instrument: 'caucion-ars', date: { $lt: date } }).sort({ date: -1 }).limit(BUCKETS.length * 10).toArray();
    const usual = {};
    for (const bucket of BUCKETS) {
        const days = rows.filter(row => row.bucket === bucket.id && row.count > 0).slice(0, 10).map(row => row.sum / row.count);
        if (days.length >= MIN_HISTORY_DAYS) usual[bucket.id] = round(median(days));
    }
    return usual;
}

// Una suba cuenta si se despega de lo habitual; sin historial todavía, se compara con el mejor plazo fijo.
export function detectSpikes(buckets, usual, plazosFijos) {
    const bank = plazosFijos[0]?.tna;
    return buckets.flatMap(row => {
        const base = usual[row.bucket];
        if (base != null) return row.tasa >= base * 1.35 && row.tasa - base >= 8 ? [{ ...row, usual: base, reference: 'history' }] : [];
        if (bank != null) return row.tasa >= bank * 1.5 && row.tasa - bank >= 10 ? [{ ...row, usual: bank, reference: 'bank' }] : [];
        return [];
    }).sort((a, b) => b.tasa / b.usual - a.tasa / a.usual);
}

export const simpleGain = (amount, tna, days) => amount * tna / 100 * days / 365;

export function rateOptions(buckets, plazosFijos) {
    return [
        ...buckets.map(row => ({ kind: 'caucion', name: `Caución ${row.plazo} ${row.plazo === 1 ? 'día' : 'días'}`, tna: row.tasa, days: row.plazo })),
        ...plazosFijos.slice(0, 3).map(row => ({ kind: 'plazo-fijo', name: `Plazo fijo ${row.entidad}`, tna: row.tna, days: 30 })),
    ].map(option => ({ ...option, gain: round(simpleGain(100_000, option.tna, option.days)) }));
}

const pct = value => `${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 }).format(value)}%`;
const pesos = value => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(value);
const dias = days => `${days} ${days === 1 ? 'día' : 'días'}`;

export function ratePushPayload(spike, options) {
    const others = options.filter(option => !(option.kind === 'caucion' && option.days === spike.plazo)).slice(0, 5);
    return {
        title: `🔥 Caución a ${dias(spike.plazo)}: ${pct(spike.tasa)} anual`,
        body: `${spike.reference === 'history' ? `Lo habitual para ese plazo es ${pct(spike.usual)}` : `El mejor plazo fijo paga ${pct(spike.usual)}`}. Cada $100.000 rinden ≈ ${pesos(simpleGain(100_000, spike.tasa, spike.plazo))} brutos en ${dias(spike.plazo)}.${others.length ? `\n\nOtras opciones hoy (cada $100.000):\n${others.map(option => `• ${option.name}: ${pct(option.tna)} → ${pesos(option.gain)} en ${dias(option.days)}`).join('\n')}` : ''}`,
        url: '/precios',
    };
}

let cache;
// Vista para la app: tasas del día, lo habitual y las alternativas.
export async function ratesOverview(db, now = Date.now(), load = fetchRates) {
    if (cache && cache.expires > now && load === fetchRates) return cache.value;
    const today = argentinaDate(now);
    const { cauciones, plazosFijos } = await load();
    const fecha = cauciones.reduce((latest, row) => row.fecha > latest ? row.fecha : latest, '');
    const current = cauciones.filter(row => row.fecha === fecha);
    const buckets = bucketRates(current);
    let usual = {}, history = [];
    try {
        usual = await usualRates(db, fecha === today ? today : argentinaDate(now + 86400000));
        // Promedio diario registrado por el radar: alimenta la comparación en Evolución.
        const rows = await db.collection('rate_history').find({ instrument: 'caucion-ars', date: { $lt: argentinaDate(now + 86400000) } }).sort({ date: -1 }).limit(BUCKETS.length * 400).toArray();
        history = rows.filter(row => row.count > 0).map(row => ({ bucket: row.bucket, date: row.date, tasa: round(row.sum / row.count) }));
    } catch { /* Sin historial se muestran igual las tasas. */ }
    const bucketOf = plazo => BUCKETS.find(bucket => plazo >= bucket.min && plazo <= bucket.max)?.id ?? null;
    const value = {
        fecha, live: fecha === today,
        cauciones: current.map(row => ({ ...row, bucket: bucketOf(row.plazo), usual: usual[bucketOf(row.plazo)] ?? null })),
        history,
        spikes: fecha === today ? detectSpikes(buckets, usual, plazosFijos) : [],
        options: rateOptions(buckets, plazosFijos),
    };
    if (load === fetchRates) cache = { value, expires: now + 60_000 };
    return value;
}

export async function checkRatePush(db, env, now = Date.now(), { load = fetchRates, deliver = deliverNotification } = {}) {
    if (!isMarketOpen(now)) return;
    const today = argentinaDate(now);
    const { cauciones, plazosFijos } = await load();
    // Solo se usan tasas de la rueda de hoy: un dato viejo no es una oportunidad.
    const buckets = bucketRates(cauciones.filter(row => row.fecha === today));
    if (!buckets.length) return;
    await recordRates(db, buckets, today, now);
    const spikes = detectSpikes(buckets, await usualRates(db, today), plazosFijos);
    if (!spikes.length) return;
    const spike = spikes[0], payload = ratePushPayload(spike, rateOptions(buckets, plazosFijos));
    const users = new Map();
    for (const row of await notificationSubscriptions(db, env)) { const key = String(row.userId); if (!users.has(key)) users.set(key, []); users.get(key).push(row); }
    const deliveries = db.collection('push_deliveries');
    for (const rows of users.values()) {
        try {
            const { portfolio } = await readPortfolio(db, rows[0].userId);
            const settings = portfolio.preferences?.rateAlerts;
            if (!settings?.enabled || isQuietHours(portfolio.preferences?.quietHours, now)) continue;
            for (const row of rows) {
                if (!receives(settings, row)) continue;
                // Un aviso por día y dispositivo; se repite solo si la tasa sigue subiendo con fuerza.
                const id = digest(`rate:${row._id}:${today}`);
                const previous = await deliveries.findOne({ _id: id });
                if (previous && spike.tasa < previous.rate * 1.25) continue;
                await deliveries.updateOne({ _id: id }, { $set: { rate: spike.tasa, createdAt: new Date(now) } }, { upsert: true });
                try { await deliver(db, row, payload, env); }
                catch (error) {
                    if (previous) await deliveries.updateOne({ _id: id }, { $set: { rate: previous.rate } }); else await deliveries.deleteOne({ _id: id });
                    console.error('No se pudo enviar una alerta de tasas:', error.message);
                }
            }
        } catch (error) { console.error('No se pudieron revisar alertas de tasas:', error.message); }
    }
}
