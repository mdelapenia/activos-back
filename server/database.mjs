import { MongoClient } from 'mongodb';
import { HttpError } from './security.mjs';

let client;
let connection;

export async function ensureIndexes(db) {
    await Promise.all([
        db.collection('users').createIndex({ email: 1 }, { unique: true }),
        db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db.collection('sessions').createIndex({ userId: 1 }),
    ]);
}

export async function getDatabase() {
    if (!process.env.MONGODB_URI) throw new HttpError(503, 'El acceso todavía no está habilitado.', 'NOT_CONFIGURED');
    if (!connection) {
        client = new MongoClient(process.env.MONGODB_URI, {
            maxPoolSize: 5, maxIdleTimeMS: 60_000, serverSelectionTimeoutMS: 8000,
        });
        connection = (async () => {
            try {
                await client.connect();
                const db = client.db(process.env.MONGODB_DB || 'activos');
                await ensureIndexes(db);
                return db;
            } catch {
                await client.close().catch(() => {});
                connection = undefined;
                throw new HttpError(503, 'No se pudo conectar con tu cuenta. Volvé a intentar.', 'DATABASE_UNAVAILABLE');
            }
        })();
    }
    return connection;
}

export async function closeDatabase() {
    await client?.close();
    client = undefined;
    connection = undefined;
}
