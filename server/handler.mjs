import { registrationOptions, registerPasskey, authenticationOptions, authenticatePasskey } from './passkeys.mjs';
import { usInflation } from './inflation.mjs';
import { getDatabase } from './database.mjs';
import { digest, hashPin, HttpError, newToken, normalizeEmail, validEmail, validPin, verifyPin } from './security.mjs';
import { readPortfolio, writePortfolio } from './portfolio.mjs';
import { portfolioDividends, marketDividends } from './dividends.mjs';
import { keySettings, marketChat } from './market-ai.mjs';

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
            const allowed = { '/api/ai/keys': ['GET', 'POST'], '/api/ai/chat': ['POST'], '/api/passkey/status': ['GET'], '/api/passkey/register/options': ['POST'], '/api/passkey/register/verify': ['POST'], '/api/passkey/login/options': ['POST'], '/api/passkey/login/verify': ['POST'], '/api/login': ['POST'], '/api/register': ['POST'], '/api/logout': ['POST'], '/api/session': ['GET'], '/api/portfolio': ['GET', 'PUT'], '/api/dividends': ['GET'], '/api/dividends/market': ['GET'], '/api/inflation/us': ['GET'], '/api/benchmarks/merval': ['GET'] }[path];
            if (!allowed) throw new HttpError(404, 'No se encontró esta operación.');
            if (!allowed.includes(method)) { res.setHeader('Allow', allowed.join(', ')); throw new HttpError(405, 'Método no permitido.'); }
            const production = env.NODE_ENV === 'production' || env.VERCEL === '1';
            if (method !== 'GET') {
                const origin = env.APP_ORIGIN || (!production ? 'http://localhost:5173' : '');
                if (!origin) throw new HttpError(503, 'El acceso todavía no está habilitado.', 'NOT_CONFIGURED');
                if (req.headers.origin !== new URL(origin).origin || req.headers['x-activos-request'] !== '1') throw new HttpError(403, 'Origen de solicitud no permitido.');
            }
            const db = await database();
            const now = clock();
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
            if (path === '/api/ai/keys') return reply(200, await keySettings(db, user, env, method === 'POST' ? await jsonBody(req) : null));
            if (path === '/api/ai/chat') return reply(200, await marketChat(db, user, env, await jsonBody(req)));
            if (path === '/api/passkey/status') return reply(200, { count: await db.collection('passkeys').countDocuments({ userId: user._id }) });
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
