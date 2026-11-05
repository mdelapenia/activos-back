import webpush from 'web-push';

import { createHash } from 'node:crypto';

import { HttpError } from './security.mjs';

import { readPortfolio } from './portfolio.mjs';

import { portfolioDividends } from './dividends.mjs';



const digest = value => createHash('sha256').update(value).digest('hex');

export function dividendPaymentWhen(payDate, now = Date.now()) {

    const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

    const days = Math.round((Date.parse(`${payDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);

    const date = payDate.split('-').reverse().join('/');

    const relative = days === 0 ? 'hoy' : days === 1 ? 'mañana' : days === 7 ? 'en 1 semana' : days > 7 && days % 7 === 0 ? `en ${days / 7} semanas` : days > 1 ? `en ${days} días` : null;

    return relative ? `${relative} (${date})` : `el ${date}`;

}

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

// Las pruebas y las notificaciones reales comparten estos formatos.
function pricePushPayload(alert, price, test = false) {
    const currency = ['cedear', 'arg-stock', 'bond', 'fund'].includes(alert.assetKind) ? 'ARS' : 'USD';
    const format = value => new Intl.NumberFormat('es-AR', {
        style: 'currency', currency, maximumFractionDigits: 4
    }).format(value);
    const above = alert.direction === 'above';
    return {
        title: test
            ? `🧪 ${alert.assetName} · Alerta de precio`
            : `${above ? '📈' : '📉'} ${alert.assetName} · Alerta de precio`,
        body: `${above ? 'Alcanzó o superó' : 'Alcanzó o cayó por debajo de'} ${format(price)}. Tu objetivo era ${format(alert.threshold)}. 🎯`,
        url: '/precios'
    };
}

function dividendPushPayload(alert, event, now = Date.now(), test = false) {
    const amount = event.complete
        ? ` Estimado bruto: ${new Intl.NumberFormat('es-AR', {
            style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4
        }).format(event.total)}. 💰 `
        : '';
    return {
        title: test
            ? `🧪 Dividendo · ${alert.assetName}`
            : `💸 Dividendo · ${alert.assetName}`,
        body: `🗓️ ${event.estimated ? 'Pago estimado' : 'Pago anunciado'} ${dividendPaymentWhen(event.payDate, now)}.${amount}`,
        url: '/dividendos'
    };
}

export async function testPush(db, user, endpoint, env, alertId, deliver = sendPush, loadDividends = portfolioDividends) {
    const row = typeof endpoint === 'string' && await db.collection('push_subscriptions').findOne({ _id: digest(endpoint), userId: user._id });
    if (!row) throw new HttpError(404, 'Activá las notificaciones en este dispositivo primero.');

    let payload = { title: '🧪 Notificación de prueba', body: 'Las notificaciones están funcionando correctamente. ✅', url: '/precios' };

    if (alertId !== undefined) {
        const { portfolio } = await readPortfolio(db, user._id);
        const alert = (portfolio.alerts || []).find(item => item.id === alertId && (item.kind === 'dividend' || item.kind === 'price'));
        if (!alert) throw new HttpError(404, 'No se encontró la alerta guardada. Esperá a que termine de sincronizarse y reintentá.');

        if (alert.kind === 'price') {
            // La prueba usa el precio del proveedor, como el envío real.
            const quotes = await loadPriceQuotes([alert]);
            const price = quotes[`${alert.assetKind}:${alert.assetId}`];
            if (!Number.isFinite(price) || price <= 0) throw new HttpError(503, 'No se pudo consultar el precio actual para la prueba.');
            payload = pricePushPayload(alert, price, true);
        } else {
            if (!env.MASSIVE_API_KEY) throw new HttpError(503, 'No está configurado el proveedor de dividendos.');
            const result = await loadDividends(portfolio, env.MASSIVE_API_KEY);
            if (!result?.configured) throw new HttpError(503, 'No está disponible el proveedor de dividendos.');
            const now = Date.now();
            const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
            const positions = (result.items || []).filter(item => item.kind === alert.assetKind && item.ticker.toUpperCase() === alert.assetId.toUpperCase());
            const events = positions.filter(item => item.status === 'ok')
                .flatMap(item => item.events || [])
                .filter(event => event.eligible && event.payDate >= today)
                .sort((a, b) => a.payDate.localeCompare(b.payDate));

            if (!events.length) throw new HttpError(404, 'No hay próximos dividendos disponibles para probar esta alerta.');
            const payments = events.filter(event => event.payDate === events[0].payDate);
            const complete = positions.every(item => item.status === 'ok')
                && payments.every(event => Number.isFinite(event.estimatedGross) && event.estimatedGross >= 0);
            const event = {
                payDate: events[0].payDate,
                estimated: payments.some(item => item.estimated),
                complete,
                total: complete ? payments.reduce((sum, item) => sum + item.estimatedGross, 0) : 0
            };
            payload = dividendPushPayload(alert, event, now, true);
        }
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

                const positions = result.items.filter(item => item.kind === alert.assetKind && item.ticker.toUpperCase() === alert.assetId.toUpperCase());

                const matching = positions.filter(item => item.status === 'ok');

                const events = matching.flatMap(item => item.events || []).filter(event => {

                    const daysUntil = (Date.parse(`${event.payDate}T00:00:00Z`) - todayMs) / 86400000;

                    if (!event.eligible || daysUntil < 0 || daysUntil > alert.threshold) return false;

                    const applicable = alerts.filter(other => other.assetKind === alert.assetKind && other.assetId.toUpperCase() === alert.assetId.toUpperCase() && other.threshold >= daysUntil);

                    return alert.threshold === Math.min(...applicable.map(other => other.threshold));

                });

                const grouped = new Map();

                for (const event of events) {

                    const group = grouped.get(event.payDate) || { payDate: event.payDate, estimated: false, total: 0, complete: positions.every(item => item.status === 'ok') };

                    group.estimated ||= Boolean(event.estimated);

                    if (Number.isFinite(event.estimatedGross) && event.estimatedGross >= 0) group.total += event.estimatedGross;

                    else group.complete = false;

                    grouped.set(event.payDate, group);

                }

                for (const event of grouped.values()) for (const row of rows) {

                    const id = digest(`${row._id}:${alert.id}:${event.payDate} `);

                    try {

                        await db.collection('push_deliveries').insertOne({ _id: id, createdAt: new Date(now) });

                        try { await deliver(db, row, dividendPushPayload(alert, event, now), env); }

                        catch (error) { await db.collection('push_deliveries').deleteOne({ _id: id }); throw error; }

                    } catch (error) { if (error.code !== 11000) console.error('No se pudo enviar una alerta de dividendos:', error.message); }

                }

            }

        } catch (error) { console.error('No se pudieron revisar alertas de dividendos:', error.message); }

    }

}



// Las cotizaciones usan los mismos proveedores y unidades que la pantalla de alertas.

export async function loadPriceQuotes(alerts, fetcher = fetch) {

    const quotes = {};

    const groups = new Map();

    for (const alert of alerts) {

        const list = groups.get(alert.assetKind) || [];

        list.push(alert.assetId);

        groups.set(alert.assetKind, list);

    }

    await Promise.allSettled([...groups].map(async ([kind, ids]) => {

        const unique = [...new Set(ids)];

        const paths = { cedear: 'arg_cedears', stock: 'usa_stocks', 'arg-stock': 'arg_stocks', bond: 'arg_bonds' };

        let url;

        if (kind === 'crypto') url = `https://api.coingecko.com/api/v3/simple/price?${new URLSearchParams({ ids: unique.join(','), vs_currencies: 'usd', precision: 'full' })}`;

        else if (kind === 'fund') url = 'https://api.argentinadatos.com/v1/finanzas/fci/fondos';

        else if (paths[kind]) url = `https://data912.com/live/${paths[kind]}`;

        else return;

        const response = await fetcher(url, { signal: AbortSignal.timeout(15000) });

        if (!response.ok) throw new Error('Proveedor de precios no disponible');

        const data = await response.json();

        for (const id of unique) {

            let price;

            if (kind === 'crypto') price = data?.[id]?.usd;

            else if (kind === 'fund') {

                const [, fundId, classId] = id.split('~');

                const row = data?.fondos?.find(item => String(item?.fondoId) === fundId && String(item?.claseId) === classId);

                price = Number(row?.rendimientos?.valorCuotaparte);

            } else {

                const row = Array.isArray(data) && data.find(item => String(item?.symbol ?? '').toUpperCase() === id.toUpperCase());

                price = Number(row?.c);

                if (kind === 'bond') price /= 100;

            }

            if (typeof price === 'number' && Number.isFinite(price) && price > 0) quotes[`${kind}:${id}`] = price;

        }

    }));

    return quotes;

}



export async function checkPricePush(db, env, now = Date.now(), { loadQuotes = loadPriceQuotes, deliver = sendPush } = {}) {

    const subscriptions = await db.collection('push_subscriptions').find({}).toArray();

    const users = new Map();

    for (const row of subscriptions) { const key = String(row.userId); if (!users.has(key)) users.set(key, []); users.get(key).push(row); }

    const portfolios = [];

    for (const rows of users.values()) {

        try {

            const { portfolio } = await readPortfolio(db, rows[0].userId);

            portfolios.push({ rows, portfolio, alerts: (portfolio.alerts || []).filter(alert => alert.kind === 'price') });

        } catch (error) { console.error('No se pudieron cargar alertas de precio:', error.message); }

    }

    const quotes = await loadQuotes(portfolios.flatMap(item => item.alerts));

    for (const { rows, portfolio, alerts } of portfolios) for (const alert of alerts) {

        const price = quotes[`${alert.assetKind}:${alert.assetId}`];

        if (!Number.isFinite(price) || price <= 0) continue;

        const matched = alert.direction === 'above' ? price >= alert.threshold : price <= alert.threshold;

        for (const row of rows) {

            const id = digest(`price:${row._id}:${alert.id}`);

            if (!matched) { await db.collection('push_deliveries').deleteOne({ _id: id }); continue; }

            if (isQuietHours(portfolio.preferences?.quietHours, now)) continue;

            try {

                await db.collection('push_deliveries').insertOne({ _id: id, createdAt: new Date(now) });

                try { await deliver(db, row, pricePushPayload(alert, price), env); }
                catch (error) { await db.collection('push_deliveries').deleteOne({ _id: id }); throw error; }

            } catch (error) { if (error.code !== 11000) console.error('No se pudo enviar una alerta de precio:', error.message); }

        }

    }

}
