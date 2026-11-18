import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import { checkPin } from './pin-guard.mjs';
import { digest, HttpError, verifyPassword } from './security.mjs';

async function attempt(db, userId, now) {
    const rows = db.collection('mfa_attempts');
    await rows.deleteOne({ _id: userId, expiresAt: { $lte: new Date(now) } });
    const row = await rows.findOneAndUpdate({ _id: userId }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(now + 15 * 60_000) } }, { upsert: true, returnDocument: 'after' });
    if (row.count > 5) throw new HttpError(429, 'Demasiados intentos. Probá de nuevo en 15 minutos.', 'MFA_LOCKED');
}
const clearAttempts = (db, userId) => db.collection('mfa_attempts').deleteOne({ _id: userId });

function keyFor(env) {
    const raw = env.MFA_ENCRYPTION_KEY || '';
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32 || key.toString('base64') !== raw) throw new HttpError(503, 'La verificación en dos pasos todavía no está configurada en el servidor.', 'MFA_NOT_CONFIGURED');
    return key;
}
function seal(secret, userId, env) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyFor(env), iv);
    cipher.setAAD(Buffer.from(`mfa:${userId}`));
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function unseal(value, userId, env) {
    try {
        const cipher = createDecipheriv('aes-256-gcm', keyFor(env), Buffer.from(value.iv, 'base64'));
        cipher.setAAD(Buffer.from(`mfa:${userId}`)); cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
        return Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8');
    } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(503, 'No se puede verificar el segundo factor en este momento.', 'MFA_UNAVAILABLE'); }
}

export async function mfaStatus(db, user) {
    const row = await db.collection('mfa').findOne({ _id: user._id, enabled: true }, { projection: { recovery: 1, recoveryEntries: 1 } });
    return { enabled: !!row, recoveryCount: Array.isArray(row?.recovery) ? row.recovery.length : 0, recoveryViewAvailable: Array.isArray(row?.recoveryEntries) };
}

function makeRecovery(userId, env) {
    const codes = Array.from({ length: 8 }, () => randomBytes(8).toString('hex').toUpperCase());
    return { codes, recovery: codes.map(code => digest(code)), recoveryEntries: codes.map(code => ({ hash: digest(code), sealed: seal(code, userId, env) })) };
}

export async function startMfaSetup(db, user, body, env, now) {
    keyFor(env);
    await checkPin(db, user, body?.pin, now);
    if ((await mfaStatus(db, user)).enabled) throw new HttpError(409, 'La verificación en dos pasos ya está activa.');
    const secret = generateSecret();
    const { codes, recovery, recoveryEntries } = makeRecovery(user._id, env);
    await db.collection('mfa_setup').updateOne({ _id: user._id }, { $set: { secret: seal(secret, user._id, env), recovery, recoveryEntries, expiresAt: new Date(now + 10 * 60_000) } }, { upsert: true });
    return { secret, codes, uri: generateURI({ issuer: 'Activos', label: user.email, secret }) };
}

export async function confirmMfaSetup(db, user, body, env, now) {
    const setup = await db.collection('mfa_setup').findOne({ _id: user._id, expiresAt: { $gt: new Date(now) } });
    if (!setup) throw new HttpError(400, 'La configuración venció. Empezá de nuevo.');
    await checkPin(db, user, body?.pin, now);
    await attempt(db, user._id, now);
    const token = typeof body?.code === 'string' ? body.code.trim() : '';
    const result = /^\d{6}$/.test(token) && await verify({ secret: unseal(setup.secret, user._id, env), token, epoch: Math.floor(now / 1000), epochTolerance: 30 });
    if (!result?.valid) throw new HttpError(400, 'El código del autenticador no es válido.');
    await clearAttempts(db, user._id);
    const claimed = await db.collection('mfa_setup').findOneAndDelete({ _id: user._id, 'secret.data': setup.secret.data, expiresAt: { $gt: new Date(now) } });
    if (!claimed) throw new HttpError(409, 'La configuración ya se usó o venció.');
    try {
        await db.collection('mfa').insertOne({ _id: user._id, enabled: true, secret: setup.secret, lastStep: result.timeStep, recovery: setup.recovery, ...(Array.isArray(setup.recoveryEntries) ? { recoveryEntries: setup.recoveryEntries } : {}), createdAt: new Date(now) });
    } catch (error) { if (error.code === 11000) throw new HttpError(409, 'La verificación en dos pasos ya está activa.'); throw error; }
    return { ok: true };
}

/** Código TOTP o código de respaldo, cada uno consumido de manera atómica. */
/** `tolerance`: segundos hacia atrás o [atrás, adelante] que se acepta un código (30 s por defecto). */
export async function verifyMfa(db, userId, code, env, now, { tolerance = 30 } = {}) {
    const row = await db.collection('mfa').findOne({ _id: userId, enabled: true });
    if (!row) return false;
    await attempt(db, userId, now);
    const token = typeof code === 'string' ? code.trim().replace(/[\s-]/g, '').toUpperCase() : '';
    if (/^[A-F0-9]{16}$/.test(token)) {
        const hash = digest(token);
        const used = await db.collection('mfa').updateOne({ _id: userId, enabled: true, recovery: hash }, { $pull: { recovery: hash, recoveryEntries: { hash } } });
        if (used.modifiedCount === 1) { await clearAttempts(db, userId); return true; }
        return false;
    }
    if (!/^\d{6}$/.test(token)) return false;
    const result = await verify({ secret: unseal(row.secret, userId, env), token, epoch: Math.floor(now / 1000), epochTolerance: tolerance, afterTimeStep: row.lastStep });
    if (!result.valid) return false;
    const claimed = await db.collection('mfa').updateOne({ _id: userId, enabled: true, lastStep: row.lastStep }, { $set: { lastStep: result.timeStep } });
    if (claimed.modifiedCount === 1) { await clearAttempts(db, userId); return true; }
    return false;
}

/** Requiere un código temporal fresco; los códigos de respaldo no muestran otros códigos. */
export async function mfaDetails(db, user, body, env, now) {
    const token = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(token) || !await verifyMfa(db, user._id, token, env, now)) throw new HttpError(401, 'El código no es válido o ya se usó. Probá con uno nuevo.', 'INVALID_CREDENTIALS');
    const row = await db.collection('mfa').findOne({ _id: user._id, enabled: true });
    if (!row) throw new HttpError(404, 'La verificación en dos pasos no está activa.');
    return { secret: unseal(row.secret, user._id, env), codes: Array.isArray(row.recoveryEntries) ? row.recoveryEntries.map(entry => unseal(entry.sealed, user._id, env)) : null };
}

/** Solo migra cuentas antiguas; cambiar los códigos exige una acción explícita y otro código. */
export async function regenerateLegacyRecovery(db, user, body, env, now) {
    const current = await db.collection('mfa').findOne({ _id: user._id, enabled: true });
    if (!current || Array.isArray(current.recoveryEntries)) throw new HttpError(409, 'No hace falta generar códigos nuevos.');
    const token = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(token) || !await verifyMfa(db, user._id, token, env, now)) throw new HttpError(401, 'El código no es válido o ya se usó. Probá con uno nuevo.', 'INVALID_CREDENTIALS');
    const { codes, recovery, recoveryEntries } = makeRecovery(user._id, env);
    const updated = await db.collection('mfa').updateOne({ _id: user._id, enabled: true, recoveryEntries: { $exists: false }, 'secret.data': current.secret.data }, { $set: { recovery, recoveryEntries } });
    if (updated.modifiedCount !== 1) throw new HttpError(409, 'La configuración cambió. Volvé a intentarlo.');
    return { codes };
}

export async function disableMfa(db, user, body, env, now) {
    await checkPin(db, user, body?.pin, now);
    if (typeof body?.password === 'string') {
        await attempt(db, user._id, now);
        const account = await db.collection('users').findOne({ _id: user._id, disabled: { $ne: true } }, { projection: { passwordHash: 1 } });
        if (!await verifyPassword(body.password, account?.passwordHash)) throw new HttpError(401, 'La contraseña es incorrecta.', 'INVALID_CREDENTIALS');
        await clearAttempts(db, user._id);
    } else if (!await verifyMfa(db, user._id, body?.code, env, now)) {
        throw new HttpError(401, 'El código no es válido o ya se usó.', 'INVALID_CREDENTIALS');
    }
    await db.collection('mfa').deleteOne({ _id: user._id });
    await db.collection('mfa_setup').deleteOne({ _id: user._id });
    return { ok: true };
}
