import { closeDatabase, getDatabase } from '../server/database.mjs';
import { loadAtlasEnvironment } from '../server/environment.mjs';

try {
    loadAtlasEnvironment();
    const db = await getDatabase();
    await db.command({ ping: 1 });
    const ready = await db.collection('users').countDocuments({ pinHash: { $regex: '^scrypt-v1\\$' } });
    console.log(`MongoDB conectado. Cuentas con PIN configurado: ${ready}.`);
} catch {
    console.error('No se pudo conectar. Revisá MONGODB_URI, MONGODB_DB, los permisos y la IP autorizada en Atlas.');
    process.exitCode = 1;
} finally {
    await closeDatabase();
}
