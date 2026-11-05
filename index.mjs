import { createApiServer } from './server/http.mjs';
import handler from './server/handler.mjs';
import { closeDatabase, getDatabase } from './server/database.mjs';
import { checkDividendPush, checkPricePush } from './server/push.mjs';
import { loadAtlasEnvironment } from './server/environment.mjs';

loadAtlasEnvironment();

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT debe ser un puerto válido.');
if (process.env.NODE_ENV === 'production' && !process.env.APP_ORIGIN) {
    throw new Error('APP_ORIGIN es obligatorio en producción.');
}

const server = createApiServer(handler);
let checkingPush = false;
async function checkPush() {
    if (checkingPush) return;
    checkingPush = true;
    try { const db = await getDatabase(); await checkPricePush(db, process.env); await checkDividendPush(db, process.env); }
    catch (error) { console.error('No se pudieron revisar las notificaciones:', error.message); }
    finally { checkingPush = false; }
}
const initialPushCheck = setTimeout(() => void checkPush(), 30_000);
const pushTimer = setInterval(() => void checkPush(), 5 * 60_000);
initialPushCheck.unref();
pushTimer.unref();
server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Backend escuchando en el puerto ${port}.`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { clearTimeout(initialPushCheck); clearInterval(pushTimer); server.close(async () => {
        await closeDatabase();
        process.exitCode = 0;
    }); });
}
