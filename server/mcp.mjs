import { createHash, randomUUID } from 'node:crypto';
import { digest, HttpError, normalizeEmail, validEmail, validPin, verifyPin } from './security.mjs';
import { readPortfolio, writePortfolio } from './portfolio.mjs';

const READ = 'portfolio:read';
const WRITE = 'portfolio:write';
const ACCESS_SECONDS = 60 * 60;
const REFRESH_SECONDS = 30 * 24 * 60 * 60;
const AUTH_REQUEST_SECONDS = 10 * 60;
const MCP_PROTOCOL = '2025-11-25';
const COOKIE = 'activos_oauth_state';

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
    res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.end(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Conectar agente · Activos</title><style>body{margin:0;background:#10100f;color:#eee;font:16px system-ui,sans-serif}.card{box-sizing:border-box;width:min(460px,calc(100% - 32px));margin:8vh auto;padding:32px;border:1px solid #393936;border-radius:20px;background:#191918}h1{font-size:26px;font-weight:500}p,small{color:#aaa;line-height:1.55}label{display:block;margin:16px 0 7px;font-size:13px;color:#ccc}input[type=email],input[type=password]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #444;border-radius:10px;background:#111;color:#fff;font-size:16px}input[type=checkbox]{margin-right:9px;accent-color:#c3a773}button{width:100%;margin-top:20px;padding:13px;border:0;border-radius:10px;background:#c3a773;color:#15130f;font-weight:700;font-size:15px;cursor:pointer}.error{color:#ff9d9d}</style><main class="card">${body}</main></html>`);
}

function authPage(request, error = '') {
    const client = escapeHtml(request.clientName);
    const id = escapeHtml(request.id);
    const write = request.scopes.includes(WRITE)
        ? `<label><input type="checkbox" name="grant_write" value="yes">Permitir cambios en inversiones: agregar, editar y eliminar posiciones</label>`
        : '<p>Este cliente no solicitó permiso para modificar inversiones.</p>';
    return `<p>ACTIVOS · AUTORIZACIÓN</p><h1>Conectar ${client}</h1><p>Iniciá sesión y elegí qué puede hacer este agente en tu cuenta.</p>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}<form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${id}"><label for="email">Correo electrónico</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" required><label for="pin">PIN de Activos</label><input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="current-password" required><label><input type="checkbox" name="grant_read" value="yes" checked disabled>Consultar tus inversiones y preferencias básicas (necesario)</label>${write}<p><small>La autorización se puede revocar en cualquier momento desde Configuración → Agentes IA. Activos nunca comparte tu PIN con el proveedor de IA.</small></p><button name="approve" value="yes" type="submit">Autorizar agente</button><button name="approve" value="no" type="submit" formnovalidate>Cancelar</button></form>`;
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

function cookieValue(req) {
    return String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}

function setOAuthCookie(res, id, production, clear = false) {
    res.setHeader('Set-Cookie', `${COOKIE}=${clear ? '' : id}; Path=/oauth/authorize; HttpOnly; SameSite=Lax${production ? '; Secure' : ''}; Max-Age=${clear ? 0 : AUTH_REQUEST_SECONDS}`);
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
    const production = env.NODE_ENV === 'production' || env.VERCEL === '1';
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
        setOAuthCookie(res, id, production);
        return html(res, authPage({ id, clientName: client.name, scopes }));
    }
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return json(res, 405, { error: 'Método no permitido.' });
    }
    if (req.headers.origin && req.headers.origin !== issuer(env)) return json(res, 403, { error: 'Origen de solicitud no permitido.' });
    const form = await readForm(req);
    const id = form.get('request_id') || '';
    if (!id || id !== cookieValue(req)) return json(res, 403, { error: 'La solicitud de autorización venció. Volvé a intentarlo.' });
    const authorization = await db.collection('oauth_requests').findOne({ _id: id, expiresAt: { $gt: new Date(now) } });
    if (!authorization) return json(res, 400, { error: 'La solicitud de autorización venció. Volvé a intentarlo.' });
    const client = await db.collection('oauth_clients').findOne({ _id: authorization.clientId });
    if (!client || !client.redirectUris.includes(authorization.redirectUri)) return json(res, 400, { error: 'El cliente ya no está disponible.' });
    if (form.get('approve') !== 'yes') {
        await db.collection('oauth_requests').deleteOne({ _id: id });
        setOAuthCookie(res, '', production, true);
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
    await db.collection('oauth_requests').deleteOne({ _id: id });
    setOAuthCookie(res, '', production, true);
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
        { name: 'get_portfolio', description: 'Consulta tus inversiones y preferencias básicas. Devuelve nombres, tipos, cantidades, monedas, fechas y unidades.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
        { name: 'add_investment', description: 'Agrega una posición a tu cartera. Requiere permiso de escritura. Para tasas usa kind=rate, rate y period; para otros activos usa coin y units.', inputSchema: investmentSchema(false), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
        { name: 'update_investment', description: 'Reemplaza una posición existente por los datos indicados. Requiere permiso de escritura.', inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, investment: investmentSchema(true) }, required: ['id', 'investment'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
        { name: 'remove_investment', description: 'Elimina una posición de tu cartera por su ID. Requiere permiso de escritura.', inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
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
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
        res.statusCode = 202;
        return res.end();
    }
    let result;
    if (message.method === 'initialize') {
        const offered = message.params?.protocolVersion;
        const supported = ['2025-11-25', '2025-06-18', '2025-03-26'];
        result = { protocolVersion: supported.includes(offered) ? offered : MCP_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'activos-mcp', version: '1.0.0' }, instructions: 'Consultá la cartera antes de hacer cambios. La edición requiere autorización portfolio:write y confirmación de la persona usuaria.' };
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
