import webpush from 'web-push';
import { createHash } from 'node:crypto';
import { HttpError } from './security.mjs';
import { readPortfolio } from './portfolio.mjs';
import { portfolioDividends } from './dividends.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export async function pushConfig(db, env) {
    const subject = env.VAPID_SUBJECT || (env.APP_ORIGIN?.startsWith('https://') ? env.APP_ORIGIN : 'https://activos-nu.vercel.app');
    if (env.VAPID_PUBLIC_KEY || env.VAPID_PRIVATE_KEY) {
        if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new HttpError(503, 'La configuración push está incompleta en el servidor.');
        return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject };
    }
    const collection = db.collection('push_config');
    let row = await collection.findOne({ _id: 'vapid' });
    if (!row) {
        const keys = webpush.generateVAPIDKeys();
        try {
            await collection.updateOne({ _id: 'vapid' }, { $setOnInsert: { publicKey: keys.publicKey, privateKey: keys.privateKey, createdAt: new Date() } }, { upsert: true });
        } catch (error) {
            if (error.code !== 11000) throw error;
        }
        row = await collection.findOne({ _id: 'vapid' });
    }
    if (!row || typeof row.publicKey !== 'string' || typeof row.privateKey !== 'string' || !row.publicKey || !row.privateKey) throw new HttpError(503, 'No se pudo cargar la configuración push.');
    return { publicKey: row.publicKey, privateKey: row.privateKey, subject };
}
function validSubscription(subscription) {
    try {
        const url = new URL(subscription.endpoint);
        const allowed = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'];
        return url.protocol === 'https:' && !url.username && !url.password && allowed.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) && subscription.endpoint.length <= 2048 && /^[A-Za-z0-9_-]{87}$/.test(subscription.keys?.p256dh || '') && /^[A-Za-z0-9_-]{22}$/.test(subscription.keys?.auth || '');
    } catch { return false; }
}
export async function saveSubscription(db, user, subscription) {
    if (!validSubscription(subscription)) throw new HttpError(400, 'La suscripción de notificaciones no es válida.');
    const id = digest(subscription.endpoint);
    await db.collection('push_subscriptions').updateOne({ _id: id }, { $set: { userId: user._id, subscription: { endpoint: subscription.endpoint, keys: subscription.keys }, updatedAt: new Date() } }, { upsert: true });
}
export async function removeSubscription(db, user, endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) throw new HttpError(400, 'La suscripción de notificaciones no es válida.');
    await db.collection('push_subscriptions').deleteOne({ _id: digest(endpoint), userId: user._id });
}
export async function subscriptionStatus(db, user, endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
    return !!(await db.collection('push_subscriptions').findOne({ _id: digest(endpoint), userId: user._id }));
}
export function isQuietHours(settings, now = Date.now()) {
    if (!settings?.enabled || settings.start === settings.end) return false;
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    return settings.start < settings.end ? time >= settings.start && time < settings.end : time >= settings.start || time < settings.end;
}
export async function sendPush(db, row, payload, env) {
    const config = await pushConfig(db, env);
    try { await webpush.sendNotification(row.subscription, JSON.stringify(payload), { vapidDetails: config, TTL: 86400 }); return true; }
    catch (error) { if (error.statusCode === 404 || error.statusCode === 410) { await db.collection('push_subscriptions').deleteOne({ _id: row._id }); return false; } throw error; }
}
export async function testPush(db, user, endpoint, env, alertId, deliver = sendPush) {
    const row = typeof endpoint === 'string' && await db.collection('push_subscriptions').findOne({ _id: digest(endpoint), userId: user._id });
    if (!row) throw new HttpError(404, 'Activá las notificaciones en este dispositivo primero.');
    let payload = { title: 'Alza · notificación de prueba', body: 'Así te avisaremos cuando se acerque un dividendo de tu cartera.', url: '/dividendos' };
    if (alertId !== undefined) {
        const { portfolio } = await readPortfolio(db, user._id);
        const alert = (portfolio.alerts || []).find(item => item.id === alertId && (item.kind === 'dividend' || item.kind === 'price'));
        if (!alert) throw new HttpError(404, 'No se encontró la alerta guardada. Esperá a que termine de sincronizarse y reintentá.');
        if (alert.kind === 'price') {
            const currency = ['cedear', 'arg-stock', 'bond', 'fund'].includes(alert.assetKind) ? 'ARS' : 'USD';
            const price = new Intl.NumberFormat('es-AR', { style: 'currency', currency, maximumFractionDigits: 6 }).format(alert.threshold);
            payload = { title: `Precio · ${alert.assetName}`, body: `Prueba: ${alert.assetName} alcanzó ${alert.direction === 'above' ? 'o superó' : 'o bajó de'} ${price}.`, url: '/precios' };
        } else payload = { title: `Dividendo · ${alert.assetName}`, body: 'Prueba: así te avisaremos cuando se acerque el pago de este dividendo.', url: '/dividendos' };
    }
    if (!await deliver(db, row, payload, env)) throw new HttpError(410, 'La suscripción venció. Activá las notificaciones otra vez.');
}
export async function checkDividendPush(db, env, now = Date.now(), { loadDividends = portfolioDividends, deliver = sendPush } = {}) {
    if (!env.MASSIVE_API_KEY) return;
    const subscriptions = await db.collection('push_subscriptions').find({}).toArray();
    const users = new Map();
    for (const row of subscriptions) { const key = String(row.userId); if (!users.has(key)) users.set(key, []); users.get(key).push(row); }
    const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const todayMs = Date.parse(`${today}T00:00:00Z`);
    for (const rows of users.values()) {
        try {
            const { portfolio } = await readPortfolio(db, rows[0].userId);
            if (isQuietHours(portfolio.preferences?.quietHours, now)) continue;
            const alerts = (portfolio.alerts || []).filter(alert => alert.kind === 'dividend');
            if (!alerts.length) continue;
            const result = await loadDividends(portfolio, env.MASSIVE_API_KEY);
            if (!result.configured) continue;
            for (const alert of alerts) {
                const matching = result.items.filter(item => item.status === 'ok' && item.kind === alert.assetKind && item.ticker.toUpperCase() === alert.assetId.toUpperCase());
                const events = matching.flatMap(item => item.events || []).filter(event => {
                    const daysUntil = (Date.parse(`${event.payDate}T00:00:00Z`) - todayMs) / 86400000;
                    if (!event.eligible || daysUntil < 0 || daysUntil > alert.threshold) return false;
                    const applicable = alerts.filter(other => other.assetKind === alert.assetKind && other.assetId.toUpperCase() === alert.assetId.toUpperCase() && other.threshold >= daysUntil);
                    return alert.threshold === Math.min(...applicable.map(other => other.threshold));
                });
                for (const event of events) for (const row of rows) {
                    const id = digest(`${row._id}:${alert.id}:${event.payDate}`);
                    try {
                        await db.collection('push_deliveries').insertOne({ _id: id, createdAt: new Date(now) });
                        try { await deliver(db, row, { title: `Dividendo · ${alert.assetName}`, body: `${event.estimated ? 'Pago estimado' : 'Pago anunciado'} para el ${event.payDate.split('-').reverse().join('/')}.`, url: '/dividendos' }, env); }
                        catch (error) { await db.collection('push_deliveries').deleteOne({ _id: id }); throw error; }
                    } catch (error) { if (error.code !== 11000) console.error('No se pudo enviar una alerta de dividendos:', error.message); }
                }
            }
        } catch (error) { console.error('No se pudieron revisar alertas de dividendos:', error.message); }
    }
}
