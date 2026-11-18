import { randomUUID } from 'node:crypto';
import { checkPin } from './pin-guard.mjs';
import { HttpError, verifyPassword } from './security.mjs';
import { iolCash, iolGet, iolPositions, iolQuotes, iolRequest } from './iol.mjs';

/**
 * Comprar y vender en IOL desde la app.
 *
 * Reglas (todas se controlan acá, no en la app):
 * - Solo desde un iPhone vinculado y con PIN (o Face ID, que entrega el PIN guardado) en cada orden.
 * - Límites fijos: $500.000 por orden y $2.000.000 por día. Pasarlos: solo esa orden, con PIN + contraseña + 2FA.
 * - 24 h sin operar después de vincular un iPhone, cambiar la contraseña o reconectar IOL (o con el código 2FA).
 * - Precio de mercado con tope de ±3%: se manda una orden límite al precio de hoy ± 3%.
 * - Una orden por `requestId`: un doble toque o un reintento no la duplica.
 * - Contado inmediato (t0). Todo queda registrado en `iol_orders`.
 */

export const ORDER_LIMIT = 500_000;
export const DAILY_LIMIT = 2_000_000;
export const COOLDOWN_MS = 24 * 60 * 60_000;
export const PRICE_CAP = 0.03;
// Código 2FA de una orden: se acepta hasta 5 minutos después de generado (hay que salir a copiarlo y después poner el PIN).
// Sigue siendo de un solo uso. Hacia adelante, 30 s (por si el reloj del teléfono va adelantado).
export const ORDER_CODE_TOLERANCE = [5 * 60, 30];
const KINDS = new Set(['cedear', 'arg-stock', 'bond', 'lecap', 'fund']);
const ZONE = 'America/Argentina/Buenos_Aires';
const localDay = t => new Date(t).toLocaleDateString('en-CA', { timeZone: ZONE });
const round2 = value => Math.round(value * 100) / 100;
// Bonos y letras cotizan cada 100 nominales.
const per100 = kind => kind === 'bond' || kind === 'lecap';
/** Especie en dólares (MEP) de un activo argentino: AAPL → AAPLD, AL30 → AL30D. */
export const dollarSymbol = symbol => symbol.endsWith('D') && symbol.length > 4 ? symbol : `${symbol}D`;

function cleanRequest(body) {
    const side = body?.side === 'buy' || body?.side === 'sell' ? body.side : null;
    const kind = KINDS.has(body?.kind) ? body.kind : null;
    const symbol = typeof body?.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
    const amount = Number(body?.amount);
    const quantity = Number(body?.quantity);
    // Con qué se paga (compra) o en qué se cobra: pesos o dólares (especie D, p. ej. AAPLD).
    const currency = body?.currency === 'USD' ? 'USD' : 'ARS';
    if (!side || !kind || !/^[A-Z0-9.]{1,15}$/.test(symbol)) throw new HttpError(400, 'Elegí qué activo querés operar.');
    if (!(amount > 0 && amount <= 1e12) && !(quantity > 0 && quantity <= 1e12)) throw new HttpError(400, side === 'buy' ? 'Ingresá cuánto querés invertir.' : 'Ingresá cuánto querés vender.');
    if (currency === 'USD' && kind === 'fund') throw new HttpError(400, 'Los fondos se suscriben en pesos desde acá.', 'NO_USD');
    if (currency === 'USD' && side === 'sell') throw new HttpError(400, 'Por ahora las ventas se cobran en pesos.', 'NO_USD');
    return { side, kind, symbol, currency, amount: amount > 0 ? amount : null, quantity: quantity > 0 ? quantity : null };
}

/** Por qué una orden pide más que el PIN: límites, cuenta recién cambiada, etc. */
async function securityState(db, user, amountArs, now) {
    const [mfa, account, device, link, today] = await Promise.all([
        db.collection('mfa').findOne({ _id: user._id, enabled: true }, { projection: { _id: 1 } }),
        db.collection('users').findOne({ _id: user._id }, { projection: { passwordChangedAt: 1 } }),
        user.deviceId ? db.collection('devices').findOne({ _id: user.deviceId }, { projection: { createdAt: 1 } }) : null,
        db.collection('iol_connections').findOne({ _id: user._id }, { projection: { linkedAt: 1, connectedAt: 1 } }),
        db.collection('iol_orders').find({ userId: user._id, day: localDay(now), status: { $in: ['sending', 'sent', 'pending', 'executed', 'unknown'] } }).toArray(),
    ]);
    const usedToday = today.reduce((sum, order) => sum + (order.amountArs ?? 0), 0);
    const changes = [device?.createdAt, account?.passwordChangedAt, link?.linkedAt ?? link?.connectedAt].filter(Boolean).map(d => new Date(d).getTime());
    const lastChange = changes.length ? Math.max(...changes) : 0;
    const cooldownUntil = lastChange + COOLDOWN_MS > now ? new Date(lastChange + COOLDOWN_MS) : null;
    const overLimit = amountArs > ORDER_LIMIT || usedToday + amountArs > DAILY_LIMIT;
    return { mfaEnabled: !!mfa, usedToday: round2(usedToday), cooldownUntil, overLimit };
}

/** Precio de IOL ahora y lo que se puede operar (saldo en pesos o tenencia). */
async function marketContext(db, user, env, now, fetcher, req) {
    if (req.kind === 'fund') {
        // Fondos: se suscriben por monto y se rescatan por cuotapartes; el valor lo da el portafolio.
        const [positions, cash] = await Promise.all([iolPositions(db, user, env, now, fetcher, 'AR'), iolCash(db, user, env, now, fetcher)]);
        const holding = positions.find(p => p.symbol === req.symbol) ?? null;
        return { unitPrice: holding ? holding.value / holding.quantity : null, holding, cash: cash.find(c => c.currency === 'ARS')?.available ?? 0 };
    }
    // En dólares se opera la especie D (AAPL → AAPLD); el tipo de cambio implícito sale de las dos cotizaciones.
    const tradeSymbol = req.currency === 'USD' ? dollarSymbol(req.symbol) : req.symbol;
    const key = `${req.kind}:${tradeSymbol}`, arsKey = `${req.kind}:${req.symbol}`;
    const [{ quotes }, positions, cashList] = await Promise.all([
        iolQuotes(db, user, env, now, req.currency === 'USD' ? [key, arsKey] : [key], fetcher),
        req.side === 'sell' ? iolPositions(db, user, env, now, fetcher, 'AR') : null,
        req.side === 'buy' ? iolCash(db, user, env, now, fetcher) : null,
    ]);
    const unitPrice = quotes[key]?.price ?? null;
    if (!unitPrice) {
        if (req.currency === 'USD') throw new HttpError(409, `${req.symbol} no se puede comprar en dólares. Probá pagando en pesos.`, 'NO_USD');
        throw new HttpError(409, `IOL no tiene cotización de ${req.symbol} ahora. Probá en horario de mercado.`, 'NO_QUOTE');
    }
    const fx = req.currency === 'USD' ? (quotes[arsKey]?.price ? quotes[arsKey].price / unitPrice : null) : 1;
    if (!fx) throw new HttpError(409, `IOL no tiene cotización de ${req.symbol} en pesos ahora.`, 'NO_QUOTE');
    const holding = positions ? positions.find(p => p.symbol === req.symbol) ?? null : null;
    const cash = cashList ? cashList.find(c => c.currency === req.currency)?.available ?? 0 : null;
    return { unitPrice, holding, cash, fx, tradeSymbol };
}

/** Arma la orden: cantidad, precio tope y total estimado. Pura (sin red), para poder probarla. */
export function planOrder(req, { unitPrice, holding, cash, fx, tradeSymbol }) {
    if (req.kind === 'fund') {
        if (req.side === 'buy') {
            if (!req.amount) throw new HttpError(400, 'Los fondos se suscriben por monto.');
            if (cash != null && req.amount > cash) throw new HttpError(400, 'No tenés pesos suficientes en IOL.', 'NO_CASH');
            return { kind: 'fund', side: 'buy', symbol: req.symbol, currency: 'ARS', amount: round2(req.amount), quantity: null, unitPrice, capPrice: null, total: round2(req.amount), amountArs: round2(req.amount) };
        }
        if (!holding) throw new HttpError(400, `No tenés ${req.symbol} en IOL.`, 'NO_HOLDING');
        const quantity = req.quantity ?? (unitPrice ? req.amount / unitPrice : 0);
        if (!(quantity > 0) || quantity > holding.quantity * 1.000001) throw new HttpError(400, `Tenés ${holding.quantity} cuotapartes de ${req.symbol}.`, 'NO_HOLDING');
        const total = round2(Math.min(quantity, holding.quantity) * (unitPrice ?? 0));
        return { kind: 'fund', side: 'sell', symbol: req.symbol, currency: 'ARS', amount: null, quantity: Math.min(quantity, holding.quantity), unitPrice, capPrice: null, total, amountArs: total };
    }
    const currency = req.currency ?? 'ARS', rate = fx ?? 1, symbol = tradeSymbol ?? req.symbol;
    const cap = req.side === 'buy' ? unitPrice * (1 + PRICE_CAP) : unitPrice * (1 - PRICE_CAP);
    const noCash = () => new HttpError(400, `No tenés ${currency === 'USD' ? 'dólares' : 'pesos'} suficientes en IOL.`, 'NO_CASH');
    if (req.side === 'buy') {
        // Por monto: cantidad entera que entra aun pagando el precio tope (nunca se gasta de más). Por cantidad: la pedida.
        const quantity = req.amount ? Math.floor(req.amount / cap) : Math.floor(req.quantity);
        if (quantity < 1) throw new HttpError(400, `Con ese monto no alcanza para 1 ${per100(req.kind) ? 'nominal' : 'unidad'} de ${req.symbol}.`, 'TOO_SMALL');
        const total = round2(quantity * cap);
        if (cash != null && (req.amount ?? total) > cash) throw noCash();
        return { kind: req.kind, side: 'buy', symbol, currency, amount: req.amount ? round2(req.amount) : null, quantity, unitPrice, capPrice: cap, total, amountArs: round2(total * rate) };
    }
    if (!holding) throw new HttpError(400, `No tenés ${req.symbol} en IOL.`, 'NO_HOLDING');
    const quantity = Math.floor(req.quantity ?? req.amount / unitPrice);
    if (quantity < 1) throw new HttpError(400, 'Ingresá al menos 1 unidad para vender.', 'TOO_SMALL');
    if (quantity > holding.quantity) throw new HttpError(400, `Tenés ${holding.quantity} de ${req.symbol} para vender.`, 'NO_HOLDING');
    const total = round2(quantity * unitPrice);
    return { kind: req.kind, side: 'sell', symbol, currency, amount: null, quantity, unitPrice, capPrice: cap, total, amountArs: round2(total * rate) };
}

/**
 * Lo que la pantalla de compra necesita antes de cargar el monto: precio en pesos y en dólares
 * (si el activo tiene especie D), saldos y tenencia. Solo lectura.
 */
export async function tradeOptions(db, user, env, now, query, fetcher = fetch) {
    const kind = KINDS.has(query?.kind) ? query.kind : null;
    const symbol = typeof query?.symbol === 'string' ? query.symbol.trim().toUpperCase() : '';
    if (!kind || !/^[A-Z0-9.]{1,15}$/.test(symbol)) throw new HttpError(400, 'Elegí qué activo querés operar.');
    const usdSymbol = dollarSymbol(symbol);
    const [quoteResult, positions, cash] = await Promise.all([
        kind === 'fund' ? { quotes: {} } : iolQuotes(db, user, env, now, [`${kind}:${symbol}`, `${kind}:${usdSymbol}`], fetcher),
        iolPositions(db, user, env, now, fetcher, 'AR'),
        iolCash(db, user, env, now, fetcher),
    ]);
    const holding = positions.find(p => p.symbol === symbol) ?? null;
    const arsPrice = quoteResult.quotes[`${kind}:${symbol}`]?.price ?? (holding ? holding.value / holding.quantity : null);
    const usdPrice = quoteResult.quotes[`${kind}:${usdSymbol}`]?.price ?? null;
    return {
        symbol, kind,
        ars: arsPrice ? { symbol, price: arsPrice, changePct: quoteResult.quotes[`${kind}:${symbol}`]?.changePct ?? null } : null,
        usd: usdPrice ? { symbol: usdSymbol, price: usdPrice } : null,
        fx: arsPrice && usdPrice ? round2(arsPrice / usdPrice) : null,
        cash: { ARS: cash.find(c => c.currency === 'ARS')?.available ?? 0, USD: cash.find(c => c.currency === 'USD')?.available ?? 0 },
        holding: holding ? { quantity: holding.quantity, value: holding.value } : null,
        limits: { order: ORDER_LIMIT, daily: DAILY_LIMIT },
    };
}

/** Vista previa para la pantalla de resumen: lo que se va a mandar y qué va a pedir la app para confirmarla. */
export async function previewOrder(db, user, body, env, now, fetcher = fetch) {
    if (!user.deviceId) throw new HttpError(403, 'Comprar y vender se hace desde la app del iPhone.', 'IPHONE_ONLY');
    const req = cleanRequest(body);
    const market = await marketContext(db, user, env, now, fetcher, req);
    const plan = planOrder(req, market);
    const [security, fees] = await Promise.all([securityState(db, user, plan.amountArs, now), estimateFees(db, user, env, now, fetcher, plan)]);
    return {
        order: plan,
        fees,
        available: { cash: market.cash, holding: market.holding ? market.holding.quantity : null },
        fx: market.fx ?? 1,
        limits: { order: ORDER_LIMIT, daily: DAILY_LIMIT, usedToday: security.usedToday },
        needs: {
            override: security.overLimit, // PIN + contraseña + 2FA
            code: !!security.cooldownUntil, // 2FA (o esperar)
            mfaEnabled: security.mfaEnabled,
        },
        cooldownUntil: security.cooldownUntil,
    };
}

/** Pedido a IOL para una orden ya planificada (API nueva). */
export function orderRequest(plan, now) {
    if (plan.kind === 'fund') {
        return plan.side === 'buy'
            ? { path: '/broker/mutual-funds/subscriptions', body: { symbol: plan.symbol, amount: plan.amount } }
            : { path: '/broker/mutual-funds/redemptions', body: { symbol: plan.symbol, quantity: plan.quantity } };
    }
    return {
        path: '/broker/orders',
        body: {
            symbol: plan.symbol, market_id: 'BCBA', side: plan.side, order_type: 'limit', quantity: plan.quantity,
            // Bonos y letras: el precio va cada 100 nominales, como cotizan en IOL.
            limit_price: round2(plan.capPrice * (per100(plan.kind) ? 100 : 1)),
            due_date: localDay(now), settlement_term: 'T0',
        },
    };
}

/** Comisión y derechos de mercado según IOL (si no responde, la app muestra "según tu plan"). */
async function estimateFees(db, user, env, now, fetcher, plan) {
    if (plan.kind === 'fund') return null;
    try {
        const { body } = orderRequest(plan, now);
        const data = await iolRequest(db, user, env, now, fetcher, '/broker/orders/estimate', { method: 'POST', body, safe: true });
        const value = v => typeof v?.value === 'number' && Number.isFinite(v.value) ? v.value : 0;
        const commission = value(data?.commission), market = value(data?.regulatory_fees?.market_fee), vat = value(data?.regulatory_fees?.vat);
        return { commission: round2(commission), taxes: round2(market + vat), total: round2(commission + market + vat) };
    } catch { return null; }
}

const publicOrder = order => order && ({
    id: order._id, side: order.side, kind: order.kind, symbol: order.symbol, quantity: order.quantity, amount: order.amount, currency: order.currency ?? 'ARS', total: order.total ?? order.amountArs,
    unitPrice: order.unitPrice, capPrice: order.capPrice, amountArs: order.amountArs, status: order.status, message: order.message ?? null,
    iolNumber: order.iolNumber ?? null, createdAt: order.createdAt, updatedAt: order.updatedAt,
});

/**
 * Envía la orden. `verifyCode` es la verificación del 2FA (se inyecta para poder probarlo).
 */
export async function placeOrder(db, user, body, env, now, { fetcher = fetch, verifyCode, notify } = {}) {
    if (!user.deviceId) throw new HttpError(403, 'Comprar y vender se hace desde la app del iPhone.', 'IPHONE_ONLY');
    const requestId = typeof body?.requestId === 'string' && /^[\da-f-]{36}$/i.test(body.requestId) ? body.requestId : null;
    if (!requestId) throw new HttpError(400, 'Falta el identificador de la orden.');
    // Mismo requestId: se devuelve la orden que ya existe (no se manda otra).
    const repeated = await db.collection('iol_orders').findOne({ userId: user._id, requestId });
    if (repeated) return { order: publicOrder(repeated), repeated: true };

    await checkPin(db, user, body?.pin, now, { field: 'tu PIN' });
    const req = cleanRequest(body);
    const market = await marketContext(db, user, env, now, fetcher, req);
    const plan = planOrder(req, market);
    const security = await securityState(db, user, plan.amountArs, now);

    if (security.overLimit || security.cooldownUntil) {
        if (!security.mfaEnabled) {
            throw new HttpError(403, security.overLimit
                ? 'Esta orden supera tu límite. Para autorizarla necesitás activar la verificación en dos pasos.'
                : `Por seguridad, hasta el ${security.cooldownUntil.toLocaleString('es-AR', { timeZone: ZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} solo se puede operar con la verificación en dos pasos. Activala para operar ya.`, 'MFA_REQUIRED');
        }
        if (security.overLimit) {
            const current = await db.collection('users').findOne({ _id: user._id }, { projection: { passwordHash: 1 } });
            if (!await verifyPassword(body?.password, current?.passwordHash)) throw new HttpError(401, 'La contraseña es incorrecta.', 'INVALID_CREDENTIALS');
        }
        if (!await verifyCode(db, user._id, body?.code, env, now, { tolerance: ORDER_CODE_TOLERANCE })) throw new HttpError(401, 'El código de verificación no es válido.', 'INVALID_CREDENTIALS');
    }

    const order = {
        _id: randomUUID(), userId: user._id, requestId, deviceId: user.deviceId, day: localDay(now),
        ...plan, status: 'sending', override: security.overLimit, createdAt: new Date(now), updatedAt: new Date(now),
    };
    try { await db.collection('iol_orders').insertOne(order); }
    catch (error) {
        if (error.code === 11000) return { order: publicOrder(await db.collection('iol_orders').findOne({ userId: user._id, requestId })), repeated: true };
        throw error;
    }

    const request = orderRequest(plan, now);
    try {
        // El mismo requestId va como clave de idempotencia: IOL tampoco la duplica.
        const response = await iolRequest(db, user, env, now, fetcher, request.path, { method: 'POST', body: request.body, idempotencyKey: requestId });
        const iolNumber = response?.order_id ?? response?.transaction_id ?? null;
        await db.collection('iol_orders').updateOne({ _id: order._id }, { $set: { status: 'sent', iolNumber, updatedAt: new Date(now) } });
        order.status = 'sent'; order.iolNumber = iolNumber;
    } catch (error) {
        const status = error.code === 'IOL_UNKNOWN' ? 'unknown' : 'rejected';
        await db.collection('iol_orders').updateOne({ _id: order._id }, { $set: { status, message: error.message, updatedAt: new Date(now) } });
        order.status = status; order.message = error.message;
        // Sin conexión con IOL hay que reconectar; un rechazo de IOL se devuelve como orden rechazada (con el motivo).
        if (error.code === 'IOL_RECONNECT') throw error;
    }
    if (notify) await notify(user._id, order).catch(() => { });
    return { order: publicOrder(order) };
}

/** Estado de IOL → estado de la app. */
export function mapStatus(estado) {
    const value = String(estado ?? '').toLowerCase();
    if (/completed|finished|terminad|ejecutad|operad|liquidad/.test(value)) return 'executed';
    if (/cancelled|rejected/.test(value)) return 'cancelled';
    if (/cancel|anulad|rechaz|vencid/.test(value)) return 'cancelled';
    if (value) return 'pending';
    return null;
}

/** Órdenes del día y de los últimos 7 días, con su estado al día (consulta a IOL las que siguen abiertas). */
export async function listOrders(db, user, env, now, fetcher = fetch, { refresh = true, notify } = {}) {
    // Historial de los últimos 90 días; el estado se actualiza solo en las abiertas.
    const since = new Date(now - 90 * 24 * 60 * 60_000);
    const orders = await db.collection('iol_orders').find({ userId: user._id, createdAt: { $gt: since } }).toArray();
    const open = orders.filter(o => ['sent', 'pending'].includes(o.status) && o.iolNumber);
    if (refresh && open.length) {
        // Estado de cada orden: se busca en las operaciones de la semana por su número.
        let operations = [];
        try {
            const data = await iolGet(db, user, env, now, fetcher, `/broker/accounts/activities/operations?start_date=${localDay(now - 7 * 24 * 60 * 60_000)}&end_date=${localDay(now)}&state=all`);
            operations = Array.isArray(data) ? data : [];
        } catch { /* Se reintenta en la próxima consulta. */ }
        for (const order of open) {
            try {
                const match = operations.find(op => [op?.order_id, op?.ticket_id].some(id => id != null && String(id) === String(order.iolNumber)));
                if (!match) continue;
                const status = mapStatus(match.status);
                if (status && status !== order.status) {
                    await db.collection('iol_orders').updateOne({ _id: order._id }, { $set: { status, updatedAt: new Date(now) } });
                    order.status = status;
                    if (notify && status !== 'pending') await notify(user._id, order).catch(() => { });
                }
            } catch { /* Se reintenta en la próxima consulta. */ }
        }
    }
    return { orders: orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(publicOrder), limits: { order: ORDER_LIMIT, daily: DAILY_LIMIT } };
}

export async function cancelOrder(db, user, id, env, now, fetcher = fetch) {
    if (!user.deviceId) throw new HttpError(403, 'Las órdenes se manejan desde la app del iPhone.', 'IPHONE_ONLY');
    const order = typeof id === 'string' ? await db.collection('iol_orders').findOne({ _id: id, userId: user._id }) : null;
    if (!order) throw new HttpError(404, 'No se encontró la orden.');
    if (!['sent', 'pending'].includes(order.status) || !order.iolNumber) throw new HttpError(409, 'Esta orden ya no se puede cancelar.');
    const path = order.kind === 'fund' ? `/broker/mutual-funds/${encodeURIComponent(order.iolNumber)}` : `/broker/orders/${encodeURIComponent(order.iolNumber)}`;
    await iolRequest(db, user, env, now, fetcher, path, { method: 'DELETE' });
    await db.collection('iol_orders').updateOne({ _id: order._id }, { $set: { status: 'cancelled', updatedAt: new Date(now) } });
    return { order: publicOrder({ ...order, status: 'cancelled' }) };
}

/* ───────────── Avisos ───────────── */

const pesos = value => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(value);
export function orderPayload(order) {
    const what = `${order.side === 'buy' ? 'Compra' : 'Venta'} de ${order.symbol}`;
    const size = order.quantity ? `${order.quantity.toLocaleString('es-AR')} ${order.kind === 'fund' ? 'cuotapartes' : 'u.'}` : pesos(order.amount ?? 0);
    const value = order.currency === 'USD' ? `US$ ${(order.total ?? 0).toLocaleString('es-AR', { maximumFractionDigits: 2 })}` : pesos(order.total ?? order.amountArs ?? 0);
    const text = {
        sent: [`${what} enviada`, `${size} · ≈ ${value}. Te avisamos cuando se ejecute.`],
        unknown: [`${what}: revisá en IOL`, 'Se cortó la conexión al enviarla y no sabemos si llegó. Revisala antes de volver a intentar.'],
        executed: [`${what} ejecutada`, `${size} · ≈ ${value}.`],
        cancelled: [`${what} cancelada`, 'La orden no se ejecutó.'],
    }[order.status];
    return text ? { title: text[0], body: text[1], url: '/ordenes' } : null;
}

/** Revisa cada 5 minutos las órdenes abiertas y avisa cuando se ejecutan o se cancelan. */
export async function checkOpenOrders(db, env, now = Date.now(), { fetcher = fetch, notify } = {}) {
    const open = await db.collection('iol_orders').find({ status: { $in: ['sent', 'pending'] }, createdAt: { $gt: new Date(now - 3 * 24 * 60 * 60_000) } }).toArray();
    const users = [...new Set(open.map(o => String(o.userId)))];
    for (const id of users) {
        const order = open.find(o => String(o.userId) === id);
        try { await listOrders(db, { _id: order.userId }, env, now, fetcher, { notify }); }
        catch (error) { if (error?.code !== 'IOL_RECONNECT') console.error('No se pudieron revisar órdenes de IOL:', error.message); }
    }
}
