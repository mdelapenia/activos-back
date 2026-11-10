import { createHash, randomUUID } from 'node:crypto';
import { digest, HttpError, normalizeEmail, validEmail, validPin, verifyPin } from './security.mjs';
import { readPortfolio, writePortfolio } from './portfolio.mjs';

const READ = 'portfolio:read';
const WRITE = 'portfolio:write';
const ACCESS_SECONDS = 60 * 60;
const REFRESH_SECONDS = 30 * 24 * 60 * 60;
const AUTH_REQUEST_SECONDS = 10 * 60;
const MCP_PROTOCOL = '2025-11-25';
const MCP_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const json = (res, status, value) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
};

function issuer(env) {
    const value = env.MCP_ISSUER_URL || env.APP_ORIGIN || 'http://localhost:5173';
    const url = new URL(value);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))) {
        throw new HttpError(503, 'MCP_ISSUER_URL debe ser un origen HTTPS público.', 'NOT_CONFIGURED');
    }
    return url.origin;
}

function resource(env) { return `${issuer(env)}/mcp`; }

function noCache(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}

function html(res, body, status = 200) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; form-action 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.end(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>Conectar agente · Activos</title><style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:#0a0a09;color:#f0f0eb;font:14px/1.5 Geist,Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.page{display:grid;min-height:100dvh;place-items:center;padding:48px 20px}.wrap{width:min(100%,430px)}.brand{display:flex;align-items:center;gap:10px;margin-bottom:28px;font-size:20px;font-weight:500;letter-spacing:-.04em}.brand img{width:32px;height:32px;object-fit:contain}.sig{color:#c3a773}.card{padding:30px;border:1px solid #30302d;border-radius:22px;background:linear-gradient(145deg,rgba(195,167,115,.07),transparent 40%),#141413;box-shadow:0 24px 80px rgba(0,0,0,.38)}.eyebrow{margin:0 0 12px;color:#aaa99f;font:10px/1.4 "Geist Mono",ui-monospace,monospace;letter-spacing:.13em}.card h1{margin:0;font-size:32px;font-weight:350;line-height:1.12;letter-spacing:-.045em}.intro{margin:12px 0 24px;color:#aaa99f;font-size:13px;line-height:1.65}.field{display:block;margin:18px 0 0;color:#aaa99f;font-size:12px}.field input{display:block;width:100%;height:46px;margin-top:8px;padding:0 14px;border:1px solid #383835;border-radius:11px;outline:none;background:#1a1a19;color:#f0f0eb;font:inherit;font-size:14px}.field input:focus{border-color:#c3a773}.permission{display:flex;align-items:flex-start;gap:9px;margin:17px 0 0;color:#c5c4bc;font-size:12px;line-height:1.55}.permission input{width:15px;height:15px;margin:1px 0 0;accent-color:#c3a773;flex:none}.note{margin:18px 0 0;color:#8f8e86;font-size:11px;line-height:1.6}.actions{display:grid;gap:9px;margin-top:22px}.actions button{min-height:44px;padding:10px 16px;border:1px solid transparent;border-radius:11px;background:#c3a773;color:#171510;font-size:13px;font-weight:650;cursor:pointer}.actions button:hover{filter:brightness(1.07)}.actions .secondary{border-color:#3a3a36;background:#1c1c1a;color:#dddcd5}.error{margin:12px 0;padding:10px 12px;border:1px solid #754440;border-radius:10px;background:#321f1d;color:#ffb4a9;font-size:12px}.foot{margin:18px 0 0;text-align:center;color:#797870;font-size:10px}@media(max-width:480px){.page{padding:32px 18px}.card{padding:24px}}</style><main class="page"><div class="wrap"><div class="brand"><img src="/icon.png" alt="">alza<span class="sig">.</span></div>${body}<p class="foot">Tu cartera personal · Conexión segura con Activos</p></div></main></html>`);
}

function authPage(request, error = '') {
    const client = escapeHtml(request.clientName);
    const id = escapeHtml(request.id);
    const write = request.scopes.includes(WRITE)
        ? `<label class="permission"><input type="checkbox" name="grant_write" value="yes"><span>Permitir que este agente agregue, edite o elimine inversiones.</span></label>`
        : '<p class="note">Este agente solo solicitó acceso de lectura.</p>';
    return `<section class="card"><p class="eyebrow">INICIAR SESIÓN</p><h1>Conectar ${client}<span class="sig">.</span></h1><p class="intro">Ingresá el mismo correo y PIN que usás para entrar a Activos. Después de validar tus datos, se completará la conexión con este agente.</p>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}<form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${id}"><label class="field" for="email">Correo electrónico<input id="email" name="email" type="email" autocomplete="username" maxlength="254" required></label><label class="field" for="pin">PIN de Activos<input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="current-password" required></label><label class="permission"><input type="checkbox" checked disabled><span>Consultar tus inversiones y preferencias básicas (necesario).</span></label>${write}<p class="note">Al continuar, iniciás sesión y autorizás solo los permisos seleccionados. Podés revocar el acceso desde Configuración → Agentes IA. Activos no comparte tu PIN con el proveedor.</p><div class="actions"><button name="approve" value="yes" type="submit">Iniciar sesión y conectar</button><button class="secondary" name="approve" value="no" type="submit" formnovalidate>Cancelar</button></div></form></section>`;
}

function completedAuthorizationPage(env) {
    const app = escapeHtml(issuer(env));
    return `<section class="card"><p class="eyebrow">ESTADO DE LA CONEXIÓN</p><h1>Ya está<span class="sig">.</span></h1><p class="intro">Este paso ya no está activo. Si recién autorizaste, volvé al agente para que termine; no reenvíes el formulario. Si todavía no aparece conectado, volvé a Activos y tocá “Ya autoricé” para comprobarlo. Si no llegaste a autorizar, iniciá una conexión nueva desde el agente.</p><div class="actions"><a href="${app}" style="display:grid;place-items:center;min-height:44px;padding:10px 16px;border:1px solid transparent;border-radius:11px;background:#c3a773;color:#171510;font-size:13px;font-weight:650;text-decoration:none">Volver a Activos</a></div></section>`;
}

async function readForm(req) {
    const type = String(req.headers['content-type'] || '');
    if (!type.startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'El formato del formulario no es válido.');
    let raw = '';
    if (req.body !== undefined) raw = typeof req.body === 'string' ? req.body : new URLSearchParams(req.body).toString();
    else {
        for await (const chunk of req) {
            raw += Buffer.from(chunk).toString('utf8');
            if (Buffer.byteLength(raw) > 16_384) throw new HttpError(413, 'El formulario supera el tamaño máximo.');
        }
    }
    if (Buffer.byteLength(raw) > 16_384) throw new HttpError(413, 'El formulario supera el tamaño máximo.');
    return new URLSearchParams(raw);
}

function authorizeRedirect(redirectUri, params) {
    const target = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) if (value) target.searchParams.set(key, value);
    return target.toString();
}

function validRedirect(uri) {
    try {
        const url = new URL(uri);
        return (url.protocol === 'https:' && !url.username && !url.password && !url.hash)
            || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.hash);
    } catch { return false; }
}

async function formOAuthGrant(db, req, res, env, now) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET') {
        const clientId = url.searchParams.get('client_id') || '';
        const redirectUri = url.searchParams.get('redirect_uri') || '';
        const client = await db.collection('oauth_clients').findOne({ _id: clientId });
        const scopes = (url.searchParams.get('scope') || READ).split(/\s+/).filter(Boolean);
        const state = url.searchParams.get('state') || '';
        const challenge = url.searchParams.get('code_challenge') || '';
        if (!client || !client.redirectUris.includes(redirectUri) || url.searchParams.get('response_type') !== 'code'
            || url.searchParams.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)
            || !scopes.includes(READ) || scopes.some(scope => ![READ, WRITE].includes(scope))
            || url.searchParams.get('resource') !== resource(env) || state.length > 1024) {
            res.statusCode = 400;
            return html(res, '<h1>No se pudo iniciar la autorización</h1><p>El cliente o la solicitud no son válidos. Volvé a intentarlo desde la aplicación.</p>', 400);
        }
        const id = randomUUID();
        await db.collection('oauth_requests').insertOne({
            _id: id, clientId, clientName: client.name, redirectUri, state, challenge, scopes,
            resource: resource(env), expiresAt: new Date(now + AUTH_REQUEST_SECONDS * 1000),
        });
        return html(res, authPage({ id, clientName: client.name, scopes }));
    }
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return json(res, 405, { error: 'Método no permitido.' });
    }
    if (req.headers.origin !== issuer(env)) return json(res, 403, { error: 'Origen de solicitud no permitido.' });
    const form = await readForm(req);
    const id = form.get('request_id') || '';
    if (!/^[\da-f-]{36}$/i.test(id)) return json(res, 400, { error: 'La solicitud de autorización no es válida. Volvé a intentarlo.' });
    const authorization = await db.collection('oauth_requests').findOne({ _id: id, expiresAt: { $gt: new Date(now) } });
    if (!authorization) return html(res, completedAuthorizationPage(env), 409);
    const client = await db.collection('oauth_clients').findOne({ _id: authorization.clientId });
    if (!client || !client.redirectUris.includes(authorization.redirectUri)) return json(res, 400, { error: 'El cliente ya no está disponible.' });
    if (form.get('approve') !== 'yes') {
        await db.collection('oauth_requests').deleteOne({ _id: id });
        res.statusCode = 303;
        res.setHeader('Location', authorizeRedirect(authorization.redirectUri, { error: 'access_denied', state: authorization.state }));
        return res.end();
    }
    const email = normalizeEmail(form.get('email'));
    const pin = form.get('pin') || '';
    if (!validEmail(email) || !validPin(pin)) {
        return html(res, authPage({ ...authorization, id: authorization._id }, 'Correo o PIN incorrectos.'));
    }
    const user = await db.collection('users').findOne({ email });
    const verified = await verifyPin(pin, user?.pinHash);
    if (!verified || !user || user.disabled) return html(res, authPage({ ...authorization, id: authorization._id }, 'Correo o PIN incorrectos.'));
    const consumed = await db.collection('oauth_requests').findOneAndDelete({
        _id: id, expiresAt: { $gt: new Date(now) },
    });
    if (!consumed) return html(res, completedAuthorizationPage(env), 409);
    const grantedScopes = [READ, ...(authorization.scopes.includes(WRITE) && form.get('grant_write') === 'yes' ? [WRITE] : [])];
    await db.collection('oauth_grants').updateOne(
        { userId: user._id, clientId: authorization.clientId },
        { $set: { scopes: grantedScopes, clientName: client.name, updatedAt: new Date(now) }, $setOnInsert: { createdAt: new Date(now) } },
        { upsert: true },
    );
    const code = randomUUID() + randomUUID();
    await db.collection('oauth_codes').insertOne({
        _id: digest(code), clientId: authorization.clientId, userId: user._id,
        redirectUri: authorization.redirectUri, challenge: authorization.challenge,
        scopes: grantedScopes, resource: authorization.resource,
        expiresAt: new Date(now + 5 * 60_000),
    });
    res.statusCode = 303;
    res.setHeader('Location', authorizeRedirect(authorization.redirectUri, { code, state: authorization.state }));
    return res.end();
}

async function registerClient(db, body, now) {
    const redirects = body?.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 20
        || redirects.some(uri => typeof uri !== 'string' || uri.length > 2048 || !validRedirect(uri))
        || (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none')
        || (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || body.grant_types.some(value => value !== 'authorization_code' && value !== 'refresh_token')))
        || (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.some(value => value !== 'code')))) {
        throw new HttpError(400, 'Los datos del cliente OAuth no son válidos.');
    }
    const name = typeof body.client_name === 'string' ? body.client_name.trim().slice(0, 120) : 'Agente MCP';
    const clientId = randomUUID();
    await db.collection('oauth_clients').insertOne({
        _id: clientId, name: name || 'Agente MCP', redirectUris: [...new Set(redirects)],
        createdAt: new Date(now),
    });
    return {
        client_id: clientId, client_id_issued_at: Math.floor(now / 1000),
        redirect_uris: [...new Set(redirects)], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        client_name: name || 'Agente MCP',
    };
}

async function formFields(req) {
    const type = String(req.headers['content-type'] || '');
    if (!type.startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'El formato de la solicitud OAuth no es válido.');
    return readForm(req);
}

async function issueTokens(db, clientId, userId, scopes, target, now) {
    const accessToken = randomUUID() + randomUUID();
    const refreshToken = randomUUID() + randomUUID();
    await db.collection('oauth_access_tokens').insertOne({
        _id: digest(accessToken), clientId, userId, scopes, resource: target,
        expiresAt: new Date(now + ACCESS_SECONDS * 1000),
    });
    await db.collection('oauth_refresh_tokens').insertOne({
        _id: digest(refreshToken), clientId, userId, scopes, resource: target,
        expiresAt: new Date(now + REFRESH_SECONDS * 1000),
    });
    return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refreshToken, scope: scopes.join(' ') };
}

async function tokenEndpoint(db, req, res, env, now) {
    const form = await formFields(req);
    const clientId = form.get('client_id') || '';
    const client = await db.collection('oauth_clients').findOne({ _id: clientId });
    if (!client) return json(res, 400, { error: 'invalid_client' });
    const target = resource(env);
    if (form.get('resource') !== target) return json(res, 400, { error: 'invalid_target' });
    if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') || '';
        const redirectUri = form.get('redirect_uri') || '';
        const verifier = form.get('code_verifier') || '';
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return json(res, 400, { error: 'invalid_grant' });
        const authorization = await db.collection('oauth_codes').findOneAndDelete({
            _id: digest(code), clientId, redirectUri, resource: target, expiresAt: { $gt: new Date(now) },
        });
        if (!authorization || authorization.challenge !== createHash('sha256').update(verifier).digest('base64url')) {
            return json(res, 400, { error: 'invalid_grant' });
        }
        const grant = await db.collection('oauth_grants').findOne({ clientId, userId: authorization.userId });
        if (!grant || !authorization.scopes.every(scope => grant.scopes.includes(scope))) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, await issueTokens(db, clientId, authorization.userId, authorization.scopes, target, now));
    }
    if (form.get('grant_type') === 'refresh_token') {
        const refresh = form.get('refresh_token') || '';
        const current = await db.collection('oauth_refresh_tokens').findOneAndDelete({
            _id: digest(refresh), clientId, resource: target, expiresAt: { $gt: new Date(now) },
        });
        if (!current) return json(res, 400, { error: 'invalid_grant' });
        const grant = await db.collection('oauth_grants').findOne({ clientId, userId: current.userId });
        if (!grant || !current.scopes.every(scope => grant.scopes.includes(scope))) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, await issueTokens(db, clientId, current.userId, current.scopes, target, now));
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
}

async function revokeToken(db, req) {
    const form = await formFields(req);
    const client = await db.collection('oauth_clients').findOne({ _id: form.get('client_id') || '' });
    if (!client) return;
    const token = form.get('token') || '';
    await db.collection('oauth_access_tokens').deleteOne({ _id: digest(token), clientId: client._id });
    await db.collection('oauth_refresh_tokens').deleteOne({ _id: digest(token), clientId: client._id });
}

function toolList() {
    return [
        { name: 'get_portfolio', title: 'Consultar cartera', description: 'Consulta tus inversiones y preferencias básicas. Devuelve nombres, tipos, cantidades, monedas, fechas y unidades.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false } },
        { name: 'add_investment', title: 'Agregar inversión', description: 'Agrega una posición a tu cartera. Requiere permiso de escritura. Para tasas usa kind=rate, rate y period; para otros activos usa coin y units.', inputSchema: investmentSchema(false), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
        { name: 'update_investment', title: 'Editar inversión', description: 'Reemplaza una posición existente por los datos indicados. Requiere permiso de escritura.', inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, investment: investmentSchema(true) }, required: ['id', 'investment'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
        { name: 'remove_investment', title: 'Eliminar inversión', description: 'Elimina una posición de tu cartera por su ID. Requiere permiso de escritura.', inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
    ];
}

function investmentSchema(includeId) {
    const properties = {
        name: { type: 'string', minLength: 1, maxLength: 70 }, amount: { type: 'number', exclusiveMinimum: 0 },
        currency: { type: 'string', enum: ['USD', 'ARS'] }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        kind: { type: 'string', enum: ['rate', 'cedear', 'crypto', 'stock', 'arg-stock', 'bond', 'fund', 'morpho'] },
        rate: { type: 'number' }, period: { type: 'string', enum: ['month', 'year'] }, coin: { type: 'string', minLength: 1, maxLength: 150 },
        units: { type: 'number', exclusiveMinimum: 0 }, purchasePrice: { type: 'number', exclusiveMinimum: 0 },
        purchaseFx: { type: 'number', exclusiveMinimum: 0 }, maturityDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        costUnknown: { type: 'boolean' },
    };
    if (includeId) properties.id = { type: 'string', minLength: 1, maxLength: 128 };
    return { type: 'object', properties, required: ['name', 'amount', 'currency', 'date', 'kind'], additionalProperties: false };
}

function textResult(value, isError = false) {
    return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

async function savePortfolio(db, userId, mutate) {
    const snapshot = await readPortfolio(db, userId);
    const portfolio = structuredClone(snapshot.portfolio);
    mutate(portfolio);
    await writePortfolio(db, userId, { version: snapshot.version, mutationId: randomUUID(), portfolio });
    return readPortfolio(db, userId);
}

async function callTool(db, userId, scopes, name, args) {
    if (name === 'get_portfolio') {
        const { portfolio, version } = await readPortfolio(db, userId);
        return textResult({ version, investments: portfolio.investments, preferences: { display: portfolio.preferences.display, dollar: portfolio.preferences.dollar, horizon: portfolio.preferences.horizon } });
    }
    if (![ 'add_investment', 'update_investment', 'remove_investment' ].includes(name)) return textResult(`Herramienta desconocida: ${name}`, true);
    if (!scopes.includes(WRITE)) return textResult('Este cliente no tiene permiso de escritura. Revocalo y volvé a autorizarlo habilitando los cambios de cartera.', true);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return textResult('Los argumentos no son válidos.', true);
    try {
        const snapshot = await savePortfolio(db, userId, portfolio => {
            if (name === 'add_investment') {
                const investment = { ...args, id: typeof args.id === 'string' && args.id ? args.id : randomUUID() };
                portfolio.investments.push(investment);
            } else if (name === 'update_investment') {
                if (typeof args.id !== 'string' || !args.investment || typeof args.investment !== 'object') throw new HttpError(400, 'Indicá el ID y los datos completos de la inversión.');
                const index = portfolio.investments.findIndex(item => item.id === args.id);
                if (index < 0) throw new HttpError(404, 'No se encontró esa inversión.');
                portfolio.investments[index] = { ...args.investment, id: args.id };
            } else {
                if (typeof args.id !== 'string') throw new HttpError(400, 'Indicá el ID de la inversión.');
                const remaining = portfolio.investments.filter(item => item.id !== args.id);
                if (remaining.length === portfolio.investments.length) throw new HttpError(404, 'No se encontró esa inversión.');
                portfolio.investments = remaining;
            }
        });
        return textResult({ ok: true, version: snapshot.version, investments: snapshot.portfolio.investments });
    } catch (error) {
        return textResult(error instanceof HttpError ? error.message : 'No se pudo guardar el cambio. Volvé a consultar la cartera e intentá de nuevo.', true);
    }
}

async function authenticateBearer(db, req, env, now, res) {
    const header = String(req.headers.authorization || '');
    const token = /^Bearer ([A-Za-z0-9-]{40,100})$/.exec(header)?.[1];
    if (!token) return null;
    const access = await db.collection('oauth_access_tokens').findOne({ _id: digest(token), resource: resource(env), expiresAt: { $gt: new Date(now) } });
    if (!access) return null;
    const grant = await db.collection('oauth_grants').findOne({ clientId: access.clientId, userId: access.userId });
    if (!grant || !access.scopes.every(scope => grant.scopes.includes(scope))) return null;
    const user = await db.collection('users').findOne({ _id: access.userId, disabled: { $ne: true } }, { projection: { _id: 1 } });
    if (!user) return null;
    return { user, scopes: access.scopes };
}

function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

async function handleMcp(db, req, res, env, now) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return json(res, 405, { error: 'El transporte MCP admite solicitudes POST.' });
    }
    const accepts = String(req.headers.accept || '');
    if (!accepts.includes('application/json') || !accepts.includes('text/event-stream')) return json(res, 406, { error: 'El cliente MCP debe aceptar application/json y text/event-stream.' });
    const auth = await authenticateBearer(db, req, env, now);
    if (!auth) {
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${issuer(env)}/.well-known/oauth-protected-resource/mcp"`);
        return json(res, 401, { error: 'Se requiere autorización OAuth.' });
    }
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.startsWith('application/json')) return json(res, 415, { error: 'MCP requiere application/json.' });
    let message;
    try {
        let raw = '';
        if (req.body !== undefined) raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        else for await (const chunk of req) {
            raw += Buffer.from(chunk).toString('utf8');
            if (Buffer.byteLength(raw) > 2_000_000) return json(res, 413, { error: 'La solicitud MCP es demasiado grande.' });
        }
        message = JSON.parse(raw);
    } catch { return json(res, 400, rpcError(null, -32700, 'Invalid JSON')); }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return json(res, 400, rpcError(message?.id, -32600, 'Invalid Request'));
    let protocolVersion;
    if (message.method === 'initialize') {
        const offered = message.params?.protocolVersion;
        protocolVersion = MCP_PROTOCOLS.includes(offered) ? offered : MCP_PROTOCOL;
    } else {
        const requested = req.headers['mcp-protocol-version'];
        if (requested && !MCP_PROTOCOLS.includes(requested)) return json(res, 400, rpcError(message.id, -32600, 'Unsupported MCP protocol version'));
        protocolVersion = requested || MCP_PROTOCOL;
    }
    res.setHeader('MCP-Protocol-Version', protocolVersion);
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
        res.statusCode = 202;
        return res.end();
    }
    let result;
    if (message.method === 'initialize') {
        result = { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'activos-mcp', version: '1.0.0' }, instructions: 'Consultá la cartera antes de hacer cambios. La edición requiere autorización portfolio:write y confirmación de la persona usuaria.' };
    } else if (message.method === 'ping') {
        result = {};
    } else if (message.method === 'tools/list') {
        result = { tools: toolList() };
    } else if (message.method === 'tools/call') {
        const params = message.params || {};
        const tool = toolList().find(item => item.name === params.name);
        if (!tool) result = textResult(`Herramienta desconocida: ${String(params.name || '')}`, true);
        else if (params.name === 'get_portfolio' && !auth.scopes.includes(READ)) result = textResult('Este cliente no tiene permiso para consultar la cartera.', true);
        else result = await callTool(db, auth.user._id, auth.scopes, params.name, params.arguments || {});
        result = { content: result.content, ...(result.isError ? { isError: true } : {}) };
    } else if (message.method === 'resources/list') {
        result = { resources: [] };
    } else if (message.method === 'prompts/list') {
        result = { prompts: [] };
    } else if (message.method === 'logging/setLevel') {
        result = {};
    } else if (message.method === 'completion/complete') {
        result = { completion: { values: [], total: 0, hasMore: false } };
    } else {
        return json(res, 200, rpcError(message.id, -32601, 'Method not found'));
    }
    if (message.id === undefined) {
        res.statusCode = 202;
        return res.end();
    }
    return json(res, 200, { jsonrpc: '2.0', id: message.id, result });
}

export async function handleMcpRequest({ db, req, res, env = process.env, now = Date.now() }) {
    noCache(res);
    const path = new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '') || '/';
    if (path === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
        const base = issuer(env);
        return json(res, 200, {
            issuer: base, authorization_endpoint: `${base}/oauth/authorize`,
            token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
            revocation_endpoint: `${base}/oauth/revoke`, response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
            scopes_supported: [READ, WRITE],
        });
    }
    if ((path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') && req.method === 'GET') {
        return json(res, 200, { resource: resource(env), authorization_servers: [issuer(env)], scopes_supported: [READ, WRITE], bearer_methods_supported: ['header'] });
    }
    if (path === '/oauth/register' && req.method === 'POST') {
        let body;
        try {
            const raw = req.body !== undefined ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : await (async () => { let value = ''; for await (const chunk of req) { value += Buffer.from(chunk).toString('utf8'); if (Buffer.byteLength(value) > 32_768) throw new HttpError(413, 'La solicitud OAuth es demasiado grande.'); } return value; })();
            body = JSON.parse(raw);
        } catch (error) {
            if (error instanceof HttpError) throw error;
            return json(res, 400, { error: 'invalid_client_metadata' });
        }
        return json(res, 201, await registerClient(db, body, now));
    }
    if (path === '/oauth/authorize') return formOAuthGrant(db, req, res, env, now);
    if (path === '/oauth/token' && req.method === 'POST') return tokenEndpoint(db, req, res, env, now);
    if (path === '/oauth/revoke' && req.method === 'POST') { await revokeToken(db, req); res.statusCode = 200; return res.end(); }
    if (path === '/mcp') return handleMcp(db, req, res, env, now);
    return false;
}

export async function listAuthorizations(db, user) {
    const grants = await db.collection('oauth_grants').find({ userId: user._id }).sort({ updatedAt: -1 }).toArray();
    return grants.map(grant => ({ id: grant.clientId, name: grant.clientName, scopes: grant.scopes, updatedAt: grant.updatedAt || grant.createdAt }));
}

export async function revokeAuthorization(db, user, id) {
    if (typeof id !== 'string' || !id || id.length > 128) throw new HttpError(400, 'La autorización no es válida.');
    const result = await db.collection('oauth_grants').deleteOne({ clientId: id, userId: user._id });
    if (!result.deletedCount) throw new HttpError(404, 'No se encontró esa autorización.');
    await Promise.all([
        db.collection('oauth_access_tokens').deleteMany({ clientId: id, userId: user._id }),
        db.collection('oauth_refresh_tokens').deleteMany({ clientId: id, userId: user._id }),
    ]);
    return { ok: true };
}
