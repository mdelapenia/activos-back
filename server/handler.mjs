import { resendAddress, readResendImports } from './resend-import.mjs';
import { extractDocument } from './import-extract.mjs';
import { gmailStatus, gmailStart, gmailCallback, gmailDisconnect, gmailReadImports } from './gmail-import.mjs';
import { registrationOptions, registerPasskey, authenticationOptions, authenticatePasskey } from './passkeys.mjs';
import { usInflation } from './inflation.mjs';
import { getDatabase } from './database.mjs';
import { digest, hashPin, HttpError, newToken, validPin } from './security.mjs';
import { changePassword, checkNewPin, clientIp, completeSetup, createRecoveryCode, recoverPassword, DEVICE_SESSION_MS, listDevices, login, publicDevice, register, revokeDevice, unlock, updateCurrentDevice, WEB_SESSION_MS } from './auth.mjs';
import { readPortfolio, writePortfolio } from './portfolio.mjs';
import { allowedOrigins } from './http.mjs';
import { portfolioDividends, marketDividends } from './dividends.mjs';
import { earningsCalendar } from './market-calendar.mjs';
import { stockQuotes, stockHistory } from './stock-quotes.mjs';
import { worldClimate } from './world.mjs';
import { pushConfig, saveSubscription, removeSubscription, subscriptionStatus, testPush, alertTestPayload, saveExpoToken, removeExpoToken, expoTokenStatus, testExpoPush } from './push.mjs';
import { detectWalletNetworks, previewWalletHoldings, walletAddresses, walletHoldings } from './wallets.mjs';
import { telegramConnect, telegramDisconnect, telegramStatus, telegramTest, telegramWebhook } from './telegram.mjs';
import { summarySettings } from './scheduled-summary.mjs';
import { ratesOverview } from './rates.mjs';
import { handleMcpRequest, listAuthorizations, revokeAuthorization } from './mcp.mjs';
import { deleteAccount } from './account-deletion.mjs';
import { checkPin } from './pin-guard.mjs';
import { marketSaved } from './market-saved.mjs';

const COOKIE = 'activos_session';

function cookieToken(req) {
    const value = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return value && /^[\w-]{43}$/.test(value) ? value : null;
}

function setCookie(res, token, production, ttlMs = WEB_SESSION_MS) {
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=${production ? 'None' : 'Strict'}; Max-Age=${token ? Math.floor(ttlMs / 1000) : 0}${production ? '; Secure' : ''}`);
}

async function jsonBody(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Formato de solicitud inválido.');
    let raw;
    if (req.body !== undefined) raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    else {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
            size += Buffer.byteLength(chunk);
            if (size > 2_000_000) throw new HttpError(413, 'La cartera supera el tamaño máximo de 2 MB.');
            chunks.push(Buffer.from(chunk));
        }
        raw = Buffer.concat(chunks).toString('utf8');
    }
    if (Buffer.byteLength(raw) > 2_000_000) throw new HttpError(413, 'La cartera supera el tamaño máximo de 2 MB.');
    try { return JSON.parse(raw); } catch { throw new HttpError(400, 'La solicitud no contiene datos válidos.'); }
}

async function requireUser(db, req, now) {
    const token = cookieToken(req);
    const session = token && await db.collection('sessions').findOne({ _id: digest(token), expiresAt: { $gt: new Date(now) } });
    const user = session && await db.collection('users').findOne({ _id: session.userId, disabled: { $ne: true } }, { projection: { email: 1, name: 1, passwordHash: 1 } });
    if (!user) throw new HttpError(401, 'Ingresá con tu correo y contraseña para continuar.', 'UNAUTHENTICATED');
    // Datos de la sesión que usan las rutas; el hash de la contraseña no sale de acá.
    user.setupRequired = !user.passwordHash;
    delete user.passwordHash;
    user.deviceId = session.deviceId ?? null;
    return user;
}

const publicUser = user => ({ id: user._id.toString(), email: user.email, name: user.name ?? '' });

async function accountData(db, user, device) {
    return { user: publicUser(user), setupRequired: !user.passwordHash && user.setupRequired !== false, device: device ? publicDevice(device, device._id) : null, ...await readPortfolio(db, user._id) };
}

/** Abre una sesión. Las del iPhone quedan atadas al dispositivo y duran menos (después se entra con el PIN). */
async function startSession(db, req, res, user, now, production, { device = null, deviceToken = null } = {}) {
    const ttlMs = device ? DEVICE_SESSION_MS : WEB_SESSION_MS;
    const token = newToken();
    await db.collection('sessions').insertOne({ _id: digest(token), userId: user._id, deviceId: device?._id ?? null, createdAt: new Date(now), expiresAt: new Date(now + ttlMs) });
    const oldToken = cookieToken(req);
    if (oldToken) await db.collection('sessions').deleteOne({ _id: digest(oldToken) });
    setCookie(res, token, production, ttlMs);
    // El secreto del dispositivo se entrega una única vez, al vincularlo.
    return { ...await accountData(db, user, device), ...(deviceToken ? { deviceToken } : {}) };
}

export function createHandler({ database = getDatabase, env = process.env, clock = Date.now } = {}) {
    return async function handler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const reply = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
        try {
            const path = new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '');
            const method = req.method;
            const mcpRoute = path === '/mcp' || path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-'); 
            if (mcpRoute) {
                const db = await database();
                if (await handleMcpRequest({ db, req, res, env, now: clock() }) !== false) return;
            }
            const allowed = { '/api/push/config': ['GET'], '/api/push/subscribe': ['POST'], '/api/push/unsubscribe': ['POST'], '/api/push/status': ['POST'], '/api/push/test': ['POST'], '/api/push/native/subscribe': ['POST'], '/api/push/native/unsubscribe': ['POST'], '/api/push/native/status': ['POST'], '/api/push/native/test': ['POST'], '/api/stocks/quotes': ['GET'], '/api/stocks/history': ['GET'], '/api/world': ['GET'], '/api/imports/extract': ['POST'], '/api/imports/resend': ['GET', 'POST'], '/api/imports/gmail': ['GET', 'POST'], '/api/imports/gmail/start': ['POST'], '/api/imports/gmail/sync': ['POST'], '/api/imports/gmail/callback': ['GET'], '/api/passkey/status': ['GET'], '/api/passkey/remove': ['POST'], '/api/passkey/register/options': ['POST'], '/api/passkey/register/verify': ['POST'], '/api/passkey/login/options': ['POST'], '/api/passkey/login/verify': ['POST'], '/api/login': ['POST'], '/api/register': ['POST'], '/api/password/recover': ['POST'], '/api/password/recovery-code': ['POST'], '/api/unlock': ['POST'], '/api/account/setup': ['POST'], '/api/password': ['POST'], '/api/devices': ['GET', 'DELETE'], '/api/devices/current': ['PUT'], '/api/pin': ['POST'], '/api/pin/verify': ['POST'], '/api/account/delete': ['POST'], '/api/logout': ['POST'], '/api/session': ['GET'], '/api/portfolio': ['GET', 'PUT'], '/api/mcp/authorizations': ['GET', 'DELETE'], '/api/dividends': ['GET'], '/api/dividends/market': ['GET'], '/api/market-calendar/earnings': ['GET'], '/api/inflation/us': ['GET'], '/api/benchmarks/merval': ['GET'], '/api/rates': ['GET'], '/api/market/saved': ['GET', 'PUT'] }[path];
            const telegramMethods = { '/api/telegram': ['GET', 'DELETE'], '/api/telegram/connect': ['POST'], '/api/telegram/test': ['POST'], '/api/telegram/webhook': ['POST'] };
            if (!allowed && path !== '/api/wallets' && path !== '/api/wallets/holdings' && path !== '/api/wallets/detect' && path !== '/api/wallets/check' && path !== '/api/summaries' && !Object.hasOwn(telegramMethods, path)) throw new HttpError(404, 'No se encontró esta operación.');
            const methods = path === '/api/wallets' ? ['GET', 'POST', 'DELETE'] : path === '/api/wallets/holdings' ? ['GET'] : path === '/api/wallets/detect' || path === '/api/wallets/check' ? ['POST'] : path === '/api/summaries' ? ['GET', 'PUT'] : telegramMethods[path] || allowed;
            if (!methods.includes(method)) { res.setHeader('Allow', methods.join(', ')); throw new HttpError(405, 'Método no permitido.'); }
            const production = env.NODE_ENV === 'production' || env.VERCEL === '1';
            if (method !== 'GET' && path !== '/api/telegram/webhook') {
                const origins = allowedOrigins(env);
                if (!production) origins.add('http://localhost:5173');
                if (!origins.has(req.headers.origin) || req.headers['x-activos-request'] !== '1') throw new HttpError(403, 'Origen de solicitud no permitido.');
            }
            const db = await database();
            const now = clock();
            if (path === '/api/telegram/webhook') return reply(200, await telegramWebhook(db, env, req.headers['x-telegram-bot-api-secret-token'], await jsonBody(req), now));
            if (path === '/api/imports/gmail/callback') {
                await gmailCallback(db, env, new URL(req.url, 'http://localhost').searchParams, now);
                res.statusCode = 303; res.setHeader('Location', new URL('/importaciones', env.APP_ORIGIN).toString()); return res.end();
            }
            if (path === '/api/passkey/login/options') return reply(200, await authenticationOptions(db, env, now));
            if (path === '/api/passkey/login/verify') return reply(200, await startSession(db, req, res, await authenticatePasskey(db, await jsonBody(req), env, now), now, production));
            if (path === '/api/register' || path === '/api/login') {
                const body = await jsonBody(req);
                const { user, linked } = path === '/api/register' ? await register(db, body, clientIp(req), now) : await login(db, body, clientIp(req), now);
                return reply(path === '/api/register' ? 201 : 200, await startSession(db, req, res, user, now, production, { device: linked?.device, deviceToken: linked?.token }));
            }
            if (path === '/api/password/recover') return reply(200, await recoverPassword(db, await jsonBody(req), clientIp(req), now));
            // Solo iOS: el iPhone vinculado + el PIN abren una sesión nueva.
            if (path === '/api/unlock') {
                const { user, device } = await unlock(db, await jsonBody(req), now);
                return reply(200, await startSession(db, req, res, user, now, production, { device }));
            }
            if (path === '/api/pin') {
                const user = await requireUser(db, req, now);
                if (user.setupRequired) throw new HttpError(403, 'Creá tu contraseña para seguir usando tu cuenta.', 'SETUP_REQUIRED');
                const body = await jsonBody(req);
                if (!validPin(body?.currentPin) || !validPin(body?.newPin)) throw new HttpError(400, 'El PIN debe tener 6 dígitos.');
                await checkPin(db, user, body.currentPin, now, { field: 'el PIN actual' });
                checkNewPin(body.newPin, body.confirmPin);
                if (body.newPin === body.currentPin) throw new HttpError(400, 'Elegí un PIN distinto del actual.');
                await db.collection('users').updateOne({ _id: user._id }, { $set: { pinHash: await hashPin(body.newPin) } });
                await db.collection('password_recovery').deleteOne({ _id: user._id });
                const currentToken = cookieToken(req);
                if (currentToken) await db.collection('sessions').deleteMany({ userId: user._id, _id: { $ne: digest(currentToken) } });
                return reply(200, { ok: true });
            }
            // Comprueba el PIN sin cambiar nada (p. ej. antes de pedir el PIN nuevo). Con límite de intentos.
            if (path === '/api/pin/verify') {
                const user = await requireUser(db, req, now);
                if (user.setupRequired) throw new HttpError(403, 'Creá tu contraseña para seguir usando tu cuenta.', 'SETUP_REQUIRED');
                await checkPin(db, user, (await jsonBody(req))?.pin, now, { field: 'el PIN actual' });
                return reply(200, { ok: true });
            }
            if (path === '/api/account/delete') {
                const user = await requireUser(db, req, now);
                await deleteAccount(db, user, await jsonBody(req), env);
                setCookie(res, '', production);
                return reply(200, { ok: true });
            }
            if (path === '/api/logout') {
                const token = cookieToken(req);
                if (token) await db.collection('sessions').deleteOne({ _id: digest(token) });
                setCookie(res, '', production);
                return reply(200, { ok: true });
            }
            const user = await requireUser(db, req, now);
            if (path === '/api/account/setup') return reply(200, await completeSetup(db, user, await jsonBody(req), now));
            // Cuenta vieja (solo PIN): hasta que cree su contraseña solo puede ver la sesión y completarla.
            if (user.setupRequired && path !== '/api/session') throw new HttpError(403, 'Creá tu contraseña para seguir usando tu cuenta.', 'SETUP_REQUIRED');
            if (path === '/api/password/recovery-code') return reply(200, await createRecoveryCode(db, user, now));
            if (path === '/api/password') return reply(200, await changePassword(db, user, await jsonBody(req), cookieToken(req), now));
            if (path === '/api/devices') {
                if (method === 'GET') return reply(200, { devices: await listDevices(db, user) });
                const result = await revokeDevice(db, user, (await jsonBody(req))?.id);
                if (result.current) setCookie(res, '', production);
                return reply(200, result);
            }
            if (path === '/api/devices/current') return reply(200, await updateCurrentDevice(db, user, await jsonBody(req)));
            if (path === '/api/mcp/authorizations') {
                if (method === 'GET') return reply(200, { authorizations: await listAuthorizations(db, user) });
                return reply(200, await revokeAuthorization(db, user, (await jsonBody(req))?.id));
            }
            if (path === '/api/market/saved') return reply(200, await marketSaved(db, user, method === 'GET' ? null : await jsonBody(req), now));
            if (path === '/api/summaries') return reply(200, await summarySettings(db, user, method === 'GET' ? null : await jsonBody(req), now));
            if (path === '/api/telegram') return reply(200, method === 'GET' ? await telegramStatus(db, user, env) : await telegramDisconnect(db, user));
            if (path === '/api/telegram/connect') return reply(200, await telegramConnect(db, user, env, now));
            if (path === '/api/telegram/test') { const body = await jsonBody(req); if (!await db.collection('telegram_subscriptions').findOne({ _id: user._id })) throw new HttpError(404, 'Conectá Telegram primero.'); const payload = body?.alertId === undefined ? undefined : await alertTestPayload(db, user, env, body.alertId); return reply(200, await telegramTest(db, user, env, payload)); }
            if (path === '/api/wallets') return reply(200, await walletAddresses(db, user, method, method === 'GET' ? null : await jsonBody(req)));
            if (path === '/api/wallets/detect') return reply(200, detectWalletNetworks((await jsonBody(req))?.address));
            if (path === '/api/wallets/check') return reply(200, await previewWalletHoldings(await jsonBody(req)));
            if (path === '/api/wallets/holdings') return reply(200, await walletHoldings(db, user, new URL(req.url, 'http://localhost').searchParams.get('id')));
            if (path === '/api/push/config') return reply(200, { publicKey: (await pushConfig(db, env)).publicKey });
            if (path === '/api/push/subscribe') { await pushConfig(db, env); await saveSubscription(db, user, await jsonBody(req)); return reply(200, { ok: true }); }
            if (path === '/api/push/unsubscribe') { await removeSubscription(db, user, (await jsonBody(req)).endpoint); return reply(200, { ok: true }); }
            if (path === '/api/push/status') return reply(200, { enabled: await subscriptionStatus(db, user, (await jsonBody(req)).endpoint) });
            if (path === '/api/push/test') { const body = await jsonBody(req); await testPush(db, user, body.endpoint, env, body.alertId); return reply(200, { ok: true }); }
            // App nativa: token de Expo en lugar de suscripción Web Push.
            if (path === '/api/push/native/subscribe') { await saveExpoToken(db, user, await jsonBody(req)); return reply(200, { ok: true }); }
            if (path === '/api/push/native/unsubscribe') { await removeExpoToken(db, user, (await jsonBody(req))?.token); return reply(200, { ok: true }); }
            if (path === '/api/push/native/status') return reply(200, { enabled: await expoTokenStatus(db, user, (await jsonBody(req))?.token) });
            if (path === '/api/push/native/test') { await testExpoPush(db, user, (await jsonBody(req))?.token, env); return reply(200, { ok: true }); }
            if (path === '/api/stocks/history') return reply(200, await stockHistory((new URL(req.url, 'http://localhost').searchParams.get('symbol') || '').toUpperCase()));
            if (path === '/api/world') { try { return reply(200, await worldClimate(now)); } catch { throw new HttpError(503, 'No se pudo consultar el clima de mercado. Volvé a intentar en un momento.'); } }
            if (path === '/api/stocks/quotes') return reply(200, await stockQuotes((new URL(req.url, 'http://localhost').searchParams.get('symbols') || '').split(',')));
            if (path === '/api/imports/resend') return reply(200, method === 'GET' ? await resendAddress(db, user, env) : await readResendImports(db, user, env));
            if (path === '/api/imports/extract') return reply(200, await extractDocument(db, user, env, await jsonBody(req)));
            if (path === '/api/imports/gmail') return reply(200, method === 'GET' ? await gmailStatus(db, user, env) : await gmailDisconnect(db, user, env));
            if (path === '/api/imports/gmail/sync') return reply(200, await gmailReadImports(db, user, env, fetch, (await jsonBody(req)).sender ?? ''));
            if (path === '/api/imports/gmail/start') return reply(200, await gmailStart(db, user, env, now));
            if (path === '/api/passkey/status') {
                const keys = await db.collection('passkeys').find({ userId: user._id }).toArray();
                return reply(200, { count: keys.length, keys: keys.map(key => ({ id: key._id, createdAt: key.createdAt || null, lastUsedAt: key.lastUsedAt || null })) });
            }
            if (path === '/api/passkey/remove') {
                const { id } = await jsonBody(req);
                if (typeof id !== 'string' || !id || id.length > 1024) throw new HttpError(400, 'Passkey inválida.');
                const result = await db.collection('passkeys').deleteOne({ _id: id, userId: user._id });
                if (!result.deletedCount) throw new HttpError(404, 'No se encontró la passkey.');
                return reply(200, { ok: true });
            }
            if (path === '/api/passkey/register/options') return reply(200, await registrationOptions(db, user, env, now));
            if (path === '/api/passkey/register/verify') return reply(200, await registerPasskey(db, user, await jsonBody(req), env, now));
            if (path === '/api/benchmarks/merval') {
                const response = await fetch('https://rosariofinanzas.ar/api/market/historical?symbol=MERVAL&period=1Y', { signal: AbortSignal.timeout(20000) });
                if (!response.ok) throw new HttpError(503, 'No se pudo consultar el Merval.');
                const rows = await response.json();
                if (!Array.isArray(rows)) throw new HttpError(503, 'Historial del Merval inválido.');
                return reply(200, rows.flatMap(row => typeof row?.date === 'string' && Number.isFinite(row.close) && row.close > 0 ? [{ fecha: row.date.slice(0, 10), valor: row.close }] : []));
            }
            if (path === '/api/rates') { try { return reply(200, await ratesOverview(db, now)); } catch { throw new HttpError(503, 'No se pudieron consultar las tasas. Volvé a intentar en un momento.'); } }
            if (path === '/api/inflation/us') return reply(200, await usInflation(now));
            if (path === '/api/session') return reply(200, await accountData(db, user, user.deviceId && await db.collection('devices').findOne({ _id: user.deviceId })));
            if (path === '/api/market-calendar/earnings') {
                const date = new URL(req.url, 'http://localhost').searchParams.get('date') ?? '';
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new HttpError(400, 'Fecha inválida.');
                return reply(200, await earningsCalendar(date));
            }
            if (path === '/api/dividends/market') return reply(200, await marketDividends(env.MASSIVE_API_KEY, fetch, now));
            if (path === '/api/dividends') return reply(200, await portfolioDividends((await readPortfolio(db, user._id)).portfolio, env.MASSIVE_API_KEY));
            if (method === 'GET') return reply(200, await readPortfolio(db, user._id));
            return reply(200, await writePortfolio(db, user._id, await jsonBody(req)));
            } catch (error) {
                if (error instanceof HttpError) return reply(error.status, { error: error.message, code: error.code, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
                // No registrar cuerpos, cookies, PINs ni errores del driver que puedan incluir credenciales.
                return reply(503, { error: 'No se pudo completar la operación. Volvé a intentar.', code: 'UNAVAILABLE' });
            }
        };
    }

    export default createHandler();
