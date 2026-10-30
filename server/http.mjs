import { createServer } from 'node:http';

const METHODS = 'GET, POST, PUT, OPTIONS';
const HEADERS = ['content-type', 'x-activos-request'];

export function createApiServer(handler, env = process.env) {
    return createServer((req, res) => {
        const origin = req.headers.origin;
        const allowedOrigin = env.APP_ORIGIN || (env.NODE_ENV !== 'production' ? 'http://localhost:5173' : '');

        if (origin && allowedOrigin && origin === new URL(allowedOrigin).origin) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            res.setHeader('Vary', 'Origin');
        }

        if (req.method === 'OPTIONS') {
            const requestedHeaders = String(req.headers['access-control-request-headers'] || '')
                .split(',').map(header => header.trim().toLowerCase()).filter(Boolean);
            const requestedMethod = req.headers['access-control-request-method'];
            if (origin !== allowedOrigin || !requestedMethod || !METHODS.split(', ').includes(requestedMethod)
                || requestedHeaders.some(header => !HEADERS.includes(header))) {
                res.statusCode = 403;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                return res.end(JSON.stringify({ error: 'Origen de solicitud no permitido.', code: 'REQUEST_ERROR' }));
            }
            res.statusCode = 204;
            res.setHeader('Access-Control-Allow-Methods', METHODS);
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Activos-Request');
            res.setHeader('Access-Control-Max-Age', '600');
            return res.end();
        }

        void handler(req, res);
    });
}
