import { createApiServer } from './server/http.mjs';
import handler from './server/handler.mjs';
import { closeDatabase } from './server/database.mjs';
import { loadAtlasEnvironment } from './server/environment.mjs';

loadAtlasEnvironment();

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT debe ser un puerto válido.');
if (process.env.NODE_ENV === 'production' && !process.env.APP_ORIGIN) {
    throw new Error('APP_ORIGIN es obligatorio en producción.');
}

const server = createApiServer(handler);
server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Backend escuchando en el puerto ${port}.`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(async () => {
        await closeDatabase();
        process.exitCode = 0;
    }));
}
