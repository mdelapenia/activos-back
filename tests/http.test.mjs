import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../server/http.mjs';

const origin = 'https://app.example.test';
let server, base;

before(async () => {
    server = createApiServer((req, res) => res.end('ok'), { APP_ORIGIN: origin });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
});

test('habilita preflight autenticado solo para el origen configurado', async () => {
    const allowed = await fetch(`${base}/api/login`, {
        method: 'OPTIONS',
        headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type,x-activos-request',
        },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');

    const denied = await fetch(`${base}/api/login`, {
        method: 'OPTIONS',
        headers: {
            Origin: 'https://otro.example.test',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type,x-activos-request',
        },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
});
