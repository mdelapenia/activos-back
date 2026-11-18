import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { checkPin } from './pin-guard.mjs';
import { HttpError } from './security.mjs';

/**
 * Conexión con IOL invertironline (solo lectura por ahora).
 *
 * - La contraseña de IOL se usa una sola vez para pedir los tokens y NO se guarda.
 * - Se guardan solo los tokens (access y refresh), cifrados con AES-256-GCM. La clave está
 *   en la variable IOL_ENCRYPTION_KEY de Railway (32 bytes en base64), nunca en la base.
 * - Los tokens nunca salen del servidor: la app solo recibe montos ya leídos.
 * - Si el refresh vence, la conexión queda "para reconectar" y la app pide la contraseña de IOL otra vez.
 * - Los rechazos de IOL nunca se devuelven como 401: un 401 es "tu sesión de Activos venció".
 */

// API nueva de IOL (developers.iolinversiones.com): mismo usuario y contraseña de la app, sin activación aparte.
export const IOL_BASE = 'https://api.iolinversiones.com';
const REFRESH_DAYS = 30;
const MAX_CONNECT_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60_000;

function keyFor(env) {
    const raw = env.IOL_ENCRYPTION_KEY || '';
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32 || key.toString('base64') !== raw) throw new HttpError(503, 'La conexión con IOL todavía no está configurada en el servidor.', 'IOL_NOT_CONFIGURED');
    return key;
}
export const iolConfigured = env => { try { keyFor(env); return true; } catch { return false; } };

// El texto cifrado queda atado a la cuenta (AAD): no sirve copiarlo a otra persona.
function seal(value, userId, env) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyFor(env), iv);
    cipher.setAAD(Buffer.from(`iol:${userId}`));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function unseal(value, userId, env) {
    try {
        const cipher = createDecipheriv('aes-256-gcm', keyFor(env), Buffer.from(value.iv, 'base64'));
        cipher.setAAD(Buffer.from(`iol:${userId}`)); cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
        return Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8');
    } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(503, 'No se pudo leer la conexión con IOL. Volvé a conectarla.', 'IOL_UNAVAILABLE'); }
}

/** usuario@correo.com → us•••@correo.com (para mostrar con qué cuenta está conectado). */
export function maskUser(username) {
    const [name, domain] = String(username).split('@');
    const visible = name.slice(0, Math.min(2, Math.max(1, name.length - 1)));
    return `${visible}•••${domain ? `@${domain}` : ''}`;
}

const dateOf = (value, fallback) => { const t = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(t) ? t : fallback; };

/** Respuestas de la API nueva: `{ meta, data, error }`. */
const unwrap = json => json && typeof json === 'object' && 'data' in json && ('meta' in json || 'error' in json) ? json.data : json;

/** POST /auth/token (password o refresh_token). Nunca registra la respuesta: trae tokens. */
async function requestToken(params, fetcher, now) {
    let response;
    try {
        response = await fetcher(`${IOL_BASE}/auth/token`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(params), signal: AbortSignal.timeout(20_000),
        });
    } catch { throw new HttpError(502, 'IOL no responde. Probá de nuevo en un rato.', 'IOL_DOWN'); }
    const data = unwrap(await response.json().catch(() => null));
    if (!response.ok || typeof data?.access_token !== 'string') return { ok: false, status: response.status };
    return {
        ok: true,
        access: data.access_token,
        refresh: typeof data.refresh_token === 'string' ? data.refresh_token : null,
        // Access: 15 minutos. Refresh: 30 días (IOL no informa su vencimiento en la respuesta).
        expiresAt: dateOf(data.expires_at, now + (Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : 15 * 60_000)),
        refreshExpiresAt: now + REFRESH_DAYS * 24 * 60 * 60_000,
    };
}

async function countConnectAttempt(db, user, now) {
    const rows = db.collection('iol_attempts');
    const row = await rows.findOne({ _id: user._id });
    const fresh = !row || new Date(row.expiresAt).getTime() <= now;
    if (!fresh && row.count >= MAX_CONNECT_ATTEMPTS) throw new HttpError(429, 'Demasiados intentos de conexión con IOL. Probá de nuevo en 15 minutos.', 'IOL_LOCKED');
    await rows.updateOne({ _id: user._id }, { $set: { count: (fresh ? 0 : row.count) + 1, expiresAt: fresh ? new Date(now + ATTEMPT_WINDOW_MS) : row.expiresAt } }, { upsert: true });
}

function saveTokens(db, user, tokens, env, now, extra = {}) {
    return db.collection('iol_connections').updateOne({ _id: user._id }, {
        $set: {
            tokens: seal(JSON.stringify({ access: tokens.access, refresh: tokens.refresh }), user._id.toString(), env),
            expiresAt: new Date(tokens.expiresAt), refreshExpiresAt: tokens.refreshExpiresAt ? new Date(tokens.refreshExpiresAt) : null,
            needsReconnect: false, updatedAt: new Date(now), ...extra,
        },
    }, { upsert: true });
}

/** Conectar (o reconectar): PIN de Activos + usuario y contraseña de IOL. */
export async function connectIol(db, user, body, env, now, fetcher = fetch) {
    keyFor(env);
    await checkPin(db, user, body?.pin, now, { field: 'tu PIN' });
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!username || username.length > 120 || !password || password.length > 200) throw new HttpError(400, 'Ingresá tu usuario y contraseña de IOL.');
    await countConnectAttempt(db, user, now);
    const tokens = await requestToken({ grant_type: 'password', username, password }, fetcher, now);
    if (!tokens.ok) {
        if (tokens.status >= 500) throw new HttpError(502, 'IOL no responde. Probá de nuevo en un rato.', 'IOL_DOWN');
        throw new HttpError(400, 'IOL rechazó el usuario o la contraseña. Revisá los datos y que tengas la API habilitada en tu cuenta de IOL.', 'IOL_INVALID');
    }
    await db.collection('iol_attempts').deleteOne({ _id: user._id });
    const existing = await db.collection('iol_connections').findOne({ _id: user._id }, { projection: { connectedAt: 1 } });
    // `linkedAt`: cada vez que se (re)conecta IOL; después de eso hay 24 h sin operar (o 2FA).
    await saveTokens(db, user, tokens, env, now, { user: maskUser(username), linkedAt: new Date(now), ...(existing?.connectedAt ? {} : { connectedAt: new Date(now), firstSeen: {} }) });
    return iolStatus(db, user, env);
}

export async function iolStatus(db, user, env) {
    const row = await db.collection('iol_connections').findOne({ _id: user._id }, { projection: { tokens: 0 } });
    return {
        configured: iolConfigured(env),
        connected: !!row,
        needsReconnect: !!row?.needsReconnect,
        user: row?.user ?? null,
        connectedAt: row?.connectedAt ?? null,
        lastSyncAt: row?.lastSyncAt ?? null,
        idleAlert: { ...DEFAULT_IDLE_ALERT, ...(row?.idleAlert ?? {}) },
    };
}

export async function disconnectIol(db, user) {
    await db.collection('iol_connections').deleteOne({ _id: user._id });
    await db.collection('iol_history').deleteOne({ _id: user._id });
    return { ok: true };
}

// Un solo refresh a la vez por cuenta: IOL invalida el refresh anterior al usarlo.
const refreshing = new Map();

async function accessToken(db, user, env, now, fetcher, { force = false } = {}) {
    const row = await db.collection('iol_connections').findOne({ _id: user._id });
    if (!row) throw new HttpError(404, 'Todavía no conectaste IOL.', 'IOL_NOT_CONNECTED');
    if (row.needsReconnect) throw new HttpError(409, 'La conexión con IOL venció. Volvé a ingresar tu contraseña de IOL.', 'IOL_RECONNECT');
    const saved = JSON.parse(unseal(row.tokens, user._id.toString(), env));
    if (!force && new Date(row.expiresAt).getTime() - 30_000 > now) return saved.access;
    const id = user._id.toString();
    if (!refreshing.has(id)) {
        refreshing.set(id, (async () => {
            const refreshable = saved.refresh && (!row.refreshExpiresAt || new Date(row.refreshExpiresAt).getTime() > now);
            const tokens = refreshable ? await requestToken({ grant_type: 'refresh_token', refresh_token: saved.refresh }, fetcher, now) : { ok: false, status: 401 };
            if (!tokens.ok) {
                if (tokens.status >= 500) throw new HttpError(502, 'IOL no responde. Probá de nuevo en un rato.', 'IOL_DOWN');
                await db.collection('iol_connections').updateOne({ _id: user._id }, { $set: { needsReconnect: true, updatedAt: new Date(now) } });
                throw new HttpError(409, 'La conexión con IOL venció. Volvé a ingresar tu contraseña de IOL.', 'IOL_RECONNECT');
            }
            await saveTokens(db, user, tokens, env, now);
            return tokens.access;
        })().finally(() => refreshing.delete(id)));
    }
    return refreshing.get(id);
}

export async function iolGet(db, user, env, now, fetcher, path) {
    return iolRequest(db, user, env, now, fetcher, path);
}

/**
 * Llamada autenticada a IOL. Las que cambian algo (órdenes) NO se reintentan nunca: si hubo un corte,
 * no se sabe si la orden llegó, y reintentar podría duplicarla.
 */
export async function iolRequest(db, user, env, now, fetcher, path, { method = 'GET', body, idempotencyKey, safe = false } = {}) {
    // `safe`: un POST que no cambia nada (estimar, validar): se trata como lectura.
    const write = method !== 'GET' && !safe;
    const call = async token => {
        try {
            return await fetcher(`${IOL_BASE}${path}`, {
                method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(write ? 30_000 : 20_000),
            });
        } catch {
            throw write ? new HttpError(504, 'No sabemos si IOL recibió la orden (se cortó la conexión). Revisá tus órdenes antes de volver a intentar.', 'IOL_UNKNOWN')
                : new HttpError(502, 'IOL no responde. Probá de nuevo en un rato.', 'IOL_DOWN');
        }
    };
    let response = await call(await accessToken(db, user, env, now, fetcher));
    // Token rechazado antes de tiempo: se renueva una vez y se reintenta.
    if (response.status === 401) response = await call(await accessToken(db, user, env, now, fetcher, { force: true }));
    if (response.status === 401) {
        await db.collection('iol_connections').updateOne({ _id: user._id }, { $set: { needsReconnect: true } });
        throw new HttpError(409, 'La conexión con IOL venció. Volvé a ingresar tu contraseña de IOL.', 'IOL_RECONNECT');
    }
    const json = response.status === 204 ? null : await response.json().catch(() => null);
    // IOL explica por qué rechazó algo (saldo, horario, precio): se muestra tal cual, recortado.
    const detail = () => clean(json?.error?.message ?? (Array.isArray(json?.data?.messages) ? json.data.messages.map(m => m?.message).filter(Boolean).join('. ') : '') ?? '', 200);
    if (!response.ok) {
        if (method !== 'GET') { const text = detail(); throw new HttpError(400, text ? `IOL rechazó la operación: ${text}` : 'IOL rechazó la operación.', 'IOL_REJECTED'); }
        throw new HttpError(502, 'IOL no respondió bien. Probá de nuevo en un rato.', 'IOL_DOWN');
    }
    const data = unwrap(json);
    if (write && (data?.successful_purchase === false || data?.successful === false)) { const text = detail(); throw new HttpError(400, text ? `IOL rechazó la operación: ${text}` : 'IOL rechazó la operación.', 'IOL_REJECTED'); }
    if (!write && json == null && response.status !== 204) throw new HttpError(502, 'IOL devolvió datos inválidos.', 'IOL_DOWN');
    return data;
}

const currencyOf = moneda => /dolar/i.test(String(moneda ?? '')) ? 'USD' : 'ARS';
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const clean = (value, max = 80) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '';

/** Normaliza una posición de IOL (API nueva o anterior). Devuelve null si no tiene lo mínimo para mostrarla. */
export function normalizePosition(raw, country) {
    if (raw?.instrument) {
        const ins = raw.instrument;
        const symbol = clean(ins.symbol, 24).toUpperCase();
        const quantity = num(raw.quantity);
        const price = num(raw.market_value?.current_price);
        const cost = num(raw.cost_basis?.total_cost), pl = num(raw.profit_loss?.unrealized_pl);
        // Valor actual = costo + ganancia (evita el precio cada 100 nominales de los bonos).
        const value = cost != null && pl != null ? cost + pl : price != null && quantity != null ? quantity * price : null;
        if (!symbol || quantity == null || quantity <= 0 || value == null) return null;
        const entry = typeof raw.cost_basis?.entry_date === 'string' ? raw.cost_basis.entry_date.slice(0, 10) : '';
        return {
            symbol, country,
            name: clean(ins.name) || symbol,
            type: clean(ins.type || ins.asset_class, 40),
            market: clean(ins.exchange, 20),
            currency: /USD|DOLAR/i.test(String(ins.currency ?? '')) ? 'USD' : 'ARS',
            quantity, value,
            lastPrice: price,
            averagePrice: num(raw.cost_basis?.average_entry_price),
            gain: pl,
            gainPct: num(raw.profit_loss?.unrealized_pl_percent),
            dailyChangePct: num(raw.market_value?.price_change_percent),
            ...(/^\d{4}-\d{2}-\d{2}$/.test(entry) ? { since: entry } : {}),
        };
    }
    const titulo = raw?.titulo ?? {};
    const symbol = clean(titulo.simbolo, 24).toUpperCase();
    const quantity = num(raw?.cantidad);
    const value = num(raw?.valorizado);
    if (!symbol || quantity == null || quantity <= 0 || value == null) return null;
    return {
        symbol, country,
        name: clean(titulo.descripcion) || symbol,
        type: clean(titulo.tipo, 40),
        market: clean(titulo.mercado, 20),
        currency: currencyOf(titulo.moneda),
        quantity, value,
        lastPrice: num(raw.ultimoPrecio),
        averagePrice: num(raw.ppc),
        gain: num(raw.gananciaDinero),
        gainPct: num(raw.gananciaPorcentaje),
        dailyChangePct: num(raw.variacionDiaria),
    };
}

export function normalizeCash(statement) {
    // API nueva: { ars: { available: { t0, t1, ... } }, usd: { ... } }. Disponible ya = contado inmediato.
    if (statement && (statement.ars || statement.usd)) {
        const free = side => { const a = side?.available; return num(typeof a === 'object' && a ? a.t0 ?? a.T0 : a) ?? 0; };
        return [['ARS', free(statement.ars)], ['USD', free(statement.usd)]].filter(([, amount]) => amount > 0).map(([currency, available]) => ({ currency, available: Math.round(available * 100) / 100 }));
    }
    const totals = { ARS: 0, USD: 0 };
    for (const account of Array.isArray(statement?.cuentas) ? statement.cuentas : []) {
        const available = num(account?.disponible);
        if (available == null || available <= 0) continue;
        totals[currencyOf(account.moneda)] += available;
    }
    return Object.entries(totals).filter(([, amount]) => amount > 0).map(([currency, available]) => ({ currency, available: Math.round(available * 100) / 100 }));
}

const positionsOf = data => Array.isArray(data?.positions) ? data.positions : Array.isArray(data?.activos) ? data.activos : [];

/** Posiciones normalizadas de una cuenta (AR o US). */
export async function iolPositions(db, user, env, now, fetcher, country = 'AR') {
    return positionsOf(await iolGet(db, user, env, now, fetcher, `/broker/accounts/${country}/positions`)).map(raw => normalizePosition(raw, country === 'US' ? 'estados_Unidos' : 'argentina')).filter(Boolean);
}
/** Saldo disponible ya (pesos y dólares). */
export async function iolCash(db, user, env, now, fetcher) {
    return normalizeCash(await iolGet(db, user, env, now, fetcher, '/broker/accounts/AR/balances'));
}

/** Portafolio (Argentina y EE. UU.) y saldo disponible, ya normalizados para la app. */
export async function iolPortfolio(db, user, env, now, fetcher = fetch) {
    const [argentina, unitedStates, statement] = await Promise.allSettled([
        iolGet(db, user, env, now, fetcher, '/broker/accounts/AR/positions'),
        iolGet(db, user, env, now, fetcher, '/broker/accounts/US/positions'),
        iolGet(db, user, env, now, fetcher, '/broker/accounts/AR/balances'),
    ]);
    // Si se venció la conexión o IOL no responde, se avisa en lugar de mostrar datos a medias.
    const failure = [argentina, unitedStates, statement].find(r => r.status === 'rejected' && r.reason?.code === 'IOL_RECONNECT') ?? (argentina.status === 'rejected' ? argentina : null);
    if (failure) throw failure.reason;
    const positions = [
        ...positionsOf(argentina.value).map(raw => normalizePosition(raw, 'argentina')),
        ...(unitedStates.status === 'fulfilled' ? positionsOf(unitedStates.value) : []).map(raw => normalizePosition(raw, 'estados_Unidos')),
    ].filter(Boolean);
    const cash = statement.status === 'fulfilled' ? normalizeCash(statement.value) : [];

    // Fecha en que cada activo apareció por primera vez en IOL (la API no da la fecha de compra).
    const row = await db.collection('iol_connections').findOne({ _id: user._id }, { projection: { firstSeen: 1 } });
    const firstSeen = { ...(row?.firstSeen ?? {}) };
    const today = new Date(now).toISOString().slice(0, 10);
    let changed = false;
    for (const p of positions) {
        const key = `${p.country}:${p.symbol}`.replace(/[.$]/g, "_");
        if (!firstSeen[key]) { firstSeen[key] = today; changed = true; }
        // La API nueva da la fecha de compra; si no, la de la primera vez que apareció.
        p.since = p.since ?? firstSeen[key];
    }
    await db.collection('iol_connections').updateOne({ _id: user._id }, { $set: { lastSyncAt: new Date(now), ...(changed ? { firstSeen } : {}) } });
    return { positions, cash, partial: unitedStates.status === 'rejected' || statement.status === 'rejected', syncedAt: new Date(now) };
}

/* ───────────── Cotizaciones de IOL ───────────── */

// Las cotizaciones son datos de mercado (iguales para todos): se guardan 60 s para no pedirlas de más.
const quoteCache = new Map();
const QUOTE_KINDS = new Set(['cedear', 'arg-stock', 'bond', 'lecap']);
// Bonos y letras cotizan cada 100 de valor nominal; la app usa el precio por 1 nominal.
const perUnit = (kind, price) => kind === 'bond' || kind === 'lecap' ? price / 100 : price;

async function inBatches(list, size, task) {
    const results = [];
    for (let i = 0; i < list.length; i += size) results.push(...await Promise.allSettled(list.slice(i, i + size).map(task)));
    return results;
}

/** Precio y variación del día de IOL para activos argentinos (`tipo:TICKER`, p. ej. `cedear:AAPL`). */
export async function iolQuotes(db, user, env, now, keys, fetcher = fetch) {
    const wanted = [...new Set((Array.isArray(keys) ? keys : []).filter(key => typeof key === 'string'))].map(key => {
        const [kind, symbol = ''] = key.split(':');
        return { key, kind, symbol: symbol.toUpperCase() };
    }).filter(item => QUOTE_KINDS.has(item.kind) && /^[A-Z0-9.]{1,15}$/.test(item.symbol)).slice(0, 80);
    const quotes = {};
    await inBatches(wanted, 6, async item => {
        const cached = quoteCache.get(item.symbol);
        const data = cached && cached.expires > now ? cached.data : await iolGet(db, user, env, now, fetcher, `/broker/market-data/${encodeURIComponent(item.symbol)}/quote?market=BCBA&term=T0`);
        if (!cached || cached.expires <= now) quoteCache.set(item.symbol, { data, expires: now + 60_000 });
        const price = num(data?.prices?.current) ?? num(data?.prices?.close) ?? num(data?.ultimoPrecio);
        if (price == null || price <= 0) return;
        quotes[item.key] = { price: perUnit(item.kind, price), changePct: num(data?.change?.percent) ?? num(data?.variacion) };
    });
    return { quotes, at: new Date(now) };
}

/* ───────────── Historial para Evolución ───────────── */

const DAY = 24 * 60 * 60_000;
const isoDay = t => new Date(t).toISOString().slice(0, 10);

export function normalizeOperation(raw) {
    const side = /venta/i.test(String(raw?.tipo ?? '')) ? 'sell' : /compra/i.test(String(raw?.tipo ?? '')) ? 'buy' : null;
    const symbol = clean(raw?.simbolo, 24).toUpperCase();
    const date = String(raw?.fechaOperada || raw?.fechaOrden || '').slice(0, 10);
    const quantity = num(raw?.cantidadOperada) ?? num(raw?.cantidad);
    const amount = num(raw?.montoOperado) ?? num(raw?.monto);
    const price = num(raw?.precioOperado) ?? num(raw?.precio);
    if (!side || !symbol || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !quantity || quantity <= 0) return null;
    return { side, symbol, date, quantity, amount, price };
}

/**
 * Valor diario de lo que tenés en IOL (cuenta argentina) durante el último año, con tus operaciones
 * reales y el precio de cierre de cada día. Las tenencias se reconstruyen hacia atrás desde las de hoy.
 * Pura: recibe los datos ya traídos de IOL (así se puede probar sin red).
 */
export function buildHistory({ positions, operations, series, from, to }) {
    const days = [];
    for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += DAY) days.push(isoDay(t));
    const current = new Map(positions.map(p => [p.symbol, p]));
    const symbols = [...new Set([...positions.map(p => p.symbol), ...operations.map(o => o.symbol)])];
    // Factor de precio: 1 para acciones y CEDEARs; 0,01 para bonos (cotizan cada 100 nominales).
    const factor = symbol => {
        const p = current.get(symbol);
        if (p?.lastPrice && p.quantity) return p.value / (p.quantity * p.lastPrice) < 0.1 ? 0.01 : 1;
        const op = operations.find(o => o.symbol === symbol && o.amount && o.price);
        return op && op.amount / (op.quantity * op.price) < 0.1 ? 0.01 : 1;
    };
    const lines = symbols.map(symbol => {
        const ops = operations.filter(o => o.symbol === symbol);
        const qtyAt = day => (current.get(symbol)?.quantity ?? 0) - ops.filter(o => o.date > day).reduce((q, o) => q + (o.side === 'buy' ? o.quantity : -o.quantity), 0);
        const closes = series[symbol] ?? {};
        const known = Object.keys(closes).sort();
        const isFund = /fondo/i.test(current.get(symbol)?.type ?? '');
        return { symbol, ops, qtyAt, closes, firstClose: known.length ? closes[known[0]] : null, f: factor(symbol), isFund };
    });
    // Costo de lo que ya tenías al empezar el período (precio promedio de IOL) + compras − ventas.
    let invested = lines.reduce((sum, line) => {
        const p = current.get(line.symbol);
        const qty = Math.max(0, line.qtyAt(from));
        const avg = p?.averagePrice != null ? p.averagePrice * line.f : p && p.gain != null ? (p.value - p.gain) / p.quantity : 0;
        return sum + qty * avg;
    }, 0);
    const last = new Map(lines.map(line => [line.symbol, line.firstClose]));
    const points = [];
    for (const day of days) {
        let value = 0, complete = true;
        for (const line of lines) {
            if (line.closes[day] != null) last.set(line.symbol, line.closes[day]);
            if (day > from) for (const o of line.ops) if (o.date === day) invested += (o.side === 'buy' ? 1 : -1) * (o.amount ?? o.quantity * (o.price ?? 0) * line.f);
            const qty = Math.max(0, line.qtyAt(day));
            if (!qty) continue;
            // Fondos: no tienen serie diaria en IOL; se usa su valor de hoy.
            if (line.isFund) { value += current.get(line.symbol).value * qty / current.get(line.symbol).quantity; continue; }
            const close = last.get(line.symbol);
            if (close == null) { complete = false; continue; }
            value += qty * close * line.f;
        }
        points.push({ date: day, value: Math.round(value * 100) / 100, invested: Math.round(Math.max(0, invested) * 100) / 100, complete });
    }
    // Hoy: el valor exacto de IOL.
    const today = positions.reduce((sum, p) => sum + (p.currency === 'ARS' ? p.value : 0), 0);
    if (points.length && today > 0) points[points.length - 1].value = Math.round(today * 100) / 100;
    return points;
}

/** Historial del último año (en pesos). Se guarda 6 horas: arma la serie con muchas consultas a IOL. */
/**
 * Historial diario del último año (en pesos), con el endpoint de historial de IOL: valor de la cuenta
 * argentina cada día y lo que depositaste o retiraste. "Invertido" = valor inicial + depósitos − retiros.
 * Se guarda 6 horas.
 */
export function historyFromIol(data) {
    const rows = (Array.isArray(data?.history) ? data.history : [])
        .map(row => ({ date: String(row?.date ?? '').slice(0, 10), equity: num(row?.equity?.ars), deposits: num(row?.cash_flow?.deposits?.ars) ?? 0, withdrawals: num(row?.cash_flow?.withdrawals?.ars) ?? 0 }))
        .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.equity != null)
        .sort((x, y) => x.date.localeCompare(y.date));
    let invested = null;
    return rows.map(row => {
        invested = invested == null ? row.equity : invested + row.deposits - row.withdrawals;
        return { date: row.date, value: Math.round(row.equity * 100) / 100, invested: Math.round(Math.max(0, invested) * 100) / 100, complete: true };
    });
}

export async function iolHistory(db, user, env, now, fetcher = fetch, { fresh = false } = {}) {
    const cached = await db.collection('iol_history').findOne({ _id: user._id });
    if (!fresh && cached && new Date(cached.expiresAt).getTime() > now) return cached.value;
    const to = isoDay(now), from = isoDay(now - 365 * DAY);
    const data = await iolGet(db, user, env, now, fetcher, `/broker/accounts/AR/portfolio/history?start_date=${from}&end_date=${to}`);
    const value = { from, to, currency: 'ARS', missing: Array.isArray(data?.missing_dates) ? data.missing_dates.slice(0, 400) : [], points: historyFromIol(data), operations: [] };
    await db.collection('iol_history').updateOne({ _id: user._id }, { $set: { value, expiresAt: new Date(now + 6 * 60 * 60_000) } }, { upsert: true });
    return value;
}

/* ───────────── Aviso de plata parada ───────────── */

export const DEFAULT_IDLE_ALERT = { enabled: false, minAmount: 50_000, days: 1, channels: 'both' };

export async function saveIdleAlert(db, user, body) {
    const row = await db.collection('iol_connections').findOne({ _id: user._id }, { projection: { _id: 1 } });
    if (!row) throw new HttpError(404, 'Todavía no conectaste IOL.', 'IOL_NOT_CONNECTED');
    const minAmount = Number(body?.minAmount), days = Number(body?.days);
    if (!Number.isFinite(minAmount) || minAmount < 0 || minAmount > 1e12) throw new HttpError(400, 'Elegí un monto mínimo válido.');
    if (!Number.isInteger(days) || days < 0 || days > 10) throw new HttpError(400, 'Elegí entre 0 y 10 días hábiles.');
    if (!['push', 'telegram', 'both'].includes(body?.channels)) throw new HttpError(400, 'Elegí dónde recibir el aviso.');
    const idleAlert = { enabled: body?.enabled === true, minAmount: Math.round(minAmount), days, channels: body.channels };
    await db.collection('iol_connections').updateOne({ _id: user._id }, { $set: { idleAlert }, $unset: { idleSince: '' } });
    return { idleAlert };
}

const ZONE = 'America/Argentina/Buenos_Aires';
const localDay = t => new Date(t).toLocaleDateString('en-CA', { timeZone: ZONE });
/** Días hábiles (lunes a viernes) entre dos fechas, sin contar la primera. */
export function businessDaysBetween(fromDay, toDay) {
    let count = 0;
    for (let t = Date.parse(`${fromDay}T12:00:00Z`) + DAY; t <= Date.parse(`${toDay}T12:00:00Z`); t += DAY) {
        const weekday = new Date(t).getUTCDay();
        if (weekday !== 0 && weekday !== 6) count++;
    }
    return count;
}

const pesos = value => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(value);
const pct = value => `${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 }).format(value)}%`;

export function idlePayload(amount, caucion) {
    if (!caucion) return { title: `Tenés ${pesos(amount)} parados en IOL`, body: 'Esa plata no está rindiendo. Mirá las tasas del día en el radar.', url: '/precios' };
    const daily = amount * caucion.tna / 100 / 365;
    return {
        title: `Tenés ${pesos(amount)} parados en IOL`,
        body: `La ${caucion.name.toLowerCase()} paga ${pct(caucion.tna)} anual: serían ≈ ${pesos(daily)} por día (${pesos(daily * 30)} en un mes), brutos.`,
        url: '/precios',
    };
}

/**
 * Revisa cada 30 minutos (en horario de mercado) si hay pesos sin invertir en IOL hace más de los días elegidos.
 * Un aviso por día como máximo. Las dependencias se inyectan para poder probarlo.
 */
export async function checkIdleCash(db, env, now = Date.now(), { fetcher = fetch, rates, deliver, subscriptions, quiet, marketOpen } = {}) {
    if (!iolConfigured(env) || (marketOpen && !marketOpen(now))) return;
    const today = localDay(now);
    const rows = await db.collection('iol_connections').find({ 'idleAlert.enabled': true, needsReconnect: { $ne: true } }).toArray();
    for (const row of rows) {
        try {
            if (row.idleCheckedAt && now - new Date(row.idleCheckedAt).getTime() < 30 * 60_000) continue;
            const user = { _id: row._id };
            const cash = await iolCash(db, user, env, now, fetcher);
            const pesosFree = cash.find(c => c.currency === 'ARS')?.available ?? 0;
            const settings = { ...DEFAULT_IDLE_ALERT, ...row.idleAlert };
            if (pesosFree < Math.max(1, settings.minAmount)) {
                await db.collection('iol_connections').updateOne({ _id: row._id }, { $set: { idleCheckedAt: new Date(now) }, $unset: { idleSince: '' } });
                continue;
            }
            const since = row.idleSince ?? today;
            const update = { idleCheckedAt: new Date(now), idleSince: since };
            if (businessDaysBetween(since, today) >= settings.days && row.idleNotified !== today && !(quiet && await quiet(row._id, now))) {
                const payload = idlePayload(pesosFree, rates ? await rates(now) : null);
                let sent = false;
                for (const target of await subscriptions(row._id)) {
                    const channel = target.channel === 'telegram' ? 'telegram' : 'push';
                    if (settings.channels !== 'both' && settings.channels !== channel) continue;
                    try { await deliver(db, target, payload, env); sent = true; } catch (error) { console.error('No se pudo enviar el aviso de plata parada:', error.message); }
                }
                if (sent) update.idleNotified = today;
            }
            await db.collection('iol_connections').updateOne({ _id: row._id }, { $set: update });
        } catch (error) {
            if (error?.code !== 'IOL_RECONNECT') console.error('No se pudo revisar la plata parada en IOL:', error.message);
        }
    }
}
