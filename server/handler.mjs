import { resendAddress, readResendImports } from './resend-import.mjs';
import { extractDocument } from './import-extract.mjs';
import { gmailStatus, gmailStart, gmailCallback, gmailDisconnect, gmailReadImports } from './gmail-import.mjs';
import { registrationOptions, registerPasskey, authenticationOptions, authenticatePasskey } from './passkeys.mjs';
import { usInflation } from './inflation.mjs';
import { getDatabase } from './database.mjs';
import { digest, hashPin, HttpError, newToken, normalizeEmail, validEmail, validPin, verifyPin } from './security.mjs';
import { readPortfolio, writePortfolio } from './portfolio.mjs';
import { portfolioDividends, marketDividends } from './dividends.mjs';
import { earningsCalendar } from './market-calendar.mjs';
import { stockQuotes, stockHistory } from './stock-quotes.mjs';
import { pushConfig, saveSubscription, removeSubscription, subscriptionStatus, testPush, alertTestPayload } from './push.mjs';
import { detectWalletNetworks, previewWalletHoldings, walletAddresses, walletHoldings } from './wallets.mjs';
import { telegramConnect, telegramDisconnect, telegramStatus, telegramTest, telegramWebhook } from './telegram.mjs';
import { summarySettings } from './scheduled-summary.mjs';
import { handleMcpRequest, listAuthorizations, revokeAuthorization } from './mcp.mjs';

const COOKIE = 'activos_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;

function cookieToken(req) {
    const value = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return value && /^[\w-]{43}$/.test(value) ? value : null;
}

function setCookie(res, token, production) {
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=${production ? 'None' : 'Strict'}; Max-Age=${token ? SESSION_SECONDS : 0}${production ? '; Secure' : ''}`);
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
    const user = session && await db.collection('users').findOne({ _id: session.userId, disabled: { $ne: true } }, { projection: { email: 1 } });
    if (!user) throw new HttpError(401, 'Ingresá con tu correo y PIN para continuar.', 'UNAUTHENTICATED');
    return user;
}

async function startSession(db, req, res, user, now, production) {
    const snapshot = await readPortfolio(db, user._id);
    const token = newToken();
    await db.collection('sessions').insertOne({ _id: digest(token), userId: user._id, createdAt: new Date(now), expiresAt: new Date(now + SESSION_SECONDS * 1000) });
    const oldToken = cookieToken(req);
    if (oldToken) await db.collection('sessions').deleteOne({ _id: digest(oldToken) });
    setCookie(res, token, production);
    return { user: { id: user._id.toString(), email: user.email }, ...snapshot };
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
                const allowed = { '/api/push/config': ['GET'], '/api/push/subscribe': ['POST'], '/api/push/unsubscribe': ['POST'], '/api/push/status': ['POST'], '/api/push/test': ['POST'], '/api/stocks/quotes': ['GET'], '/api/stocks/history': ['GET'], '/api/imports/extract': ['POST'], '/api/imports/resend': ['GET', 'POST'], '/api/imports/gmail': ['GET', 'POST'], '/api/imports/gmail/start': ['POST'], '/api/imports/gmail/sync': ['POST'], '/api/imports/gmail/callback': ['GET'], '/api/passkey/status': ['GET'], '/api/passkey/remove': ['POST'], '/api/passkey/register/options': ['POST'], '/api/passkey/register/verify': ['POST'], '/api/passkey/login/options': ['POST'], '/api/passkey/login/verify': ['POST'], '/api/login': ['POST'], '/api/register': ['POST'], '/api/logout': ['POST'], '/api/session': ['GET'], '/api/portfolio': ['GET', 'PUT'], '/api/mcp/authorizations': ['GET', 'DELETE'], '/api/dividends': ['GET'], '/api/dividends/market': ['GET'], '/api/market-calendar/earnings': ['GET'], '/api/inflation/us': ['GET'], '/api/benchmarks/merval': ['GET'] }[path];
                const telegramMethods = { '/api/telegram': ['GET', 'DELETE'], '/api/telegram/connect': ['POST'], '/api/telegram/test': ['POST'], '/api/telegram/webhook': ['POST'] };
                if (!allowed && path !== '/api/wallets' && path !== '/api/wallets/holdings' && path !== '/api/wallets/detect' && path !== '/api/wallets/check' && path !== '/api/summaries' && !Object.hasOwn(telegramMethods, path)) throw new HttpError(404, 'No se encontró esta operación.');
                const methods = path === '/api/wallets' ? ['GET', 'POST', 'DELETE'] : path === '/api/wallets/holdings' ? ['GET'] : path === '/api/wallets/detect' || path === '/api/wallets/check' ? ['POST'] : path === '/api/summaries' ? ['GET', 'PUT'] : telegramMethods[path] || allowed;
                if (!methods.includes(method)) { res.setHeader('Allow', methods.join(', ')); throw new HttpError(405, 'Método no permitido.'); }
                const production = env.NODE_ENV === 'production' || env.VERCEL === '1';
                if (method !== 'GET' && path !== '/api/telegram/webhook') {
                    const origin = env.APP_ORIGIN || (!production ? 'http://localhost:5173' : '');
                    if (!origin) throw new HttpError(503, 'El acceso todavía no está habilitado.', 'NOT_CONFIGURED');
                    if (req.headers.origin !== new URL(origin).origin || req.headers['x-activos-request'] !== '1') throw new HttpError(403, 'Origen de solicitud no permitido.');
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
                if (path === '/api/login' || path === '/api/register') {
                    const registering = path === '/api/register';
                    const body = await jsonBody(req);
                    const email = normalizeEmail(body?.email);
                    if (!validEmail(email) || !validPin(body?.pin)) throw new HttpError(400, 'Ingresá un correo válido y un PIN de 6 dígitos.');
                    if (registering) {
                        if (body.pin !== body.confirmPin) throw new HttpError(400, 'Los PINs no coinciden.');
                        const user = { email, pinHash: await hashPin(body.pin), createdAt: new Date(now) };
                        try { user._id = (await db.collection('users').insertOne(user)).insertedId; }
                        catch (error) {
                            if (error.code === 11000) throw new HttpError(409, 'Ya existe una cuenta con ese correo. Ingresá con tu PIN.', 'ACCOUNT_EXISTS');
                            throw error;
                        }
                        return reply(201, await startSession(db, req, res, user, now, production));
                    }
                    const user = await db.collection('users').findOne({ email });
                    const valid = await verifyPin(body.pin, user?.pinHash);
                    if (!valid || !user || user.disabled) throw new HttpError(401, 'Correo o PIN incorrectos.', 'INVALID_CREDENTIALS');
                    return reply(200, await startSession(db, req, res, user, now, production));
                }
                if (path === '/api/logout') {
                    const token = cookieToken(req);
                    if (token) await db.collection('sessions').deleteOne({ _id: digest(token) });
                    setCookie(res, '', production);
                    return reply(200, { ok: true });
                }
                const user = await requireUser(db, req, now);
                if (path === '/api/mcp/authorizations') {
                    if (method === 'GET') return reply(200, { authorizations: await listAuthorizations(db, user) });
                    return reply(200, await revokeAuthorization(db, user, (await jsonBody(req))?.id));
                }
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
                if (path === '/api/stocks/history') return reply(200, await stockHistory((new URL(req.url, 'http://localhost').searchParams.get('symbol') || '').toUpperCase()));
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
                if (path === '/api/inflation/us') return reply(200, await usInflation(now));
                if (path === '/api/session') return reply(200, { user: { id: user._id.toString(), email: user.email }, ...await readPortfolio(db, user._id) });
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
