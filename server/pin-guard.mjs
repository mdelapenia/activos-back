import { HttpError, validPin, verifyPin } from './security.mjs';

/**
 * Comprueba el PIN de una persona con sesión abierta (cambiar PIN, eliminar cuenta, verificar).
 * Tras 5 intentos fallidos se bloquea 15 minutos, para que nadie pruebe PINs con un teléfono ajeno.
 */
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

export async function checkPin(db, user, pin, now = Date.now(), { field = 'el PIN' } = {}) {
    if (!validPin(pin)) throw new HttpError(400, `Ingresá ${field} de 6 dígitos.`);
    const attempts = db.collection('pin_attempts');
    const row = await attempts.findOne({ _id: user._id });
    if (row?.lockedUntil && new Date(row.lockedUntil).getTime() > now) {
        const minutes = Math.ceil((new Date(row.lockedUntil).getTime() - now) / 60_000);
        throw new HttpError(429, `Demasiados intentos con un PIN incorrecto. Probá de nuevo en ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.`, 'PIN_LOCKED');
    }
    const credentials = await db.collection('users').findOne({ _id: user._id }, { projection: { pinHash: 1 } });
    if (credentials && await verifyPin(pin, credentials.pinHash)) {
        if (row) await attempts.deleteOne({ _id: user._id });
        return;
    }
    const failures = (row?.lockedUntil ? 0 : row?.failures ?? 0) + 1;
    const locked = failures >= MAX_FAILURES;
    await attempts.updateOne({ _id: user._id }, { $set: { failures: locked ? 0 : failures, lockedUntil: locked ? new Date(now + LOCK_MS) : null, updatedAt: new Date(now) } }, { upsert: true });
    const left = MAX_FAILURES - failures;
    throw new HttpError(401, locked ? 'Demasiados intentos con un PIN incorrecto. Probá de nuevo en 15 minutos.' : `El PIN actual es incorrecto. Te ${left === 1 ? 'queda 1 intento' : `quedan ${left} intentos`}.`, 'INVALID_CREDENTIALS');
}
