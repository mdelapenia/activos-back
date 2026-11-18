import { randomBytes, randomUUID } from 'node:crypto';
import { verifyMfa } from './mfa.mjs';
import {
    cleanName, digest, hashPassword, hashPin, HttpError, newToken, normalizeEmail, PASSWORD_RULE,
    validEmail, validName, validPassword, validPin, verifyPassword, verifyPin, weakPin,
} from './security.mjs';

/**
 * Cuentas y dispositivos.
 *
 * - Registro: nombre, correo, contraseña y PIN (se guardan solo los hashes).
 * - Ingreso: correo + contraseña. Desde la app de iOS, además, el iPhone queda vinculado:
 *   el servidor genera un secreto de dispositivo, se lo entrega una sola vez y guarda solo su hash.
 * - Desbloqueo (solo iOS): secreto de dispositivo + PIN. El PIN solo no alcanza: sin el
 *   secreto guardado en el Keychain de ese iPhone no se puede entrar.
 *   Tras 5 PINs incorrectos el iPhone se desvincula y hay que volver a ingresar con contraseña.
 */

const LOGIN_MAX_FAILURES = 5;
const IP_MAX_FAILURES = 30;
const REGISTER_MAX_PER_IP = 10;
const LOCK_MS = 15 * 60_000;
export const DEVICE_MAX_FAILURES = 5;
export const WEB_SESSION_MS = 7 * 24 * 60 * 60_000;
export const DEVICE_SESSION_MS = 12 * 60 * 60_000;
/** Opciones de "Pedir el PIN después de" (ms en segundo plano). */
export const LOCK_OPTIONS = [0, 30_000, 60_000, 300_000, 900_000, 3_600_000];
export const DEFAULT_LOCK_MS = 30_000;

export function clientIp(req) {
    const forwarded = req.headers?.['x-forwarded-for'];
    const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
    return first || req.socket?.remoteAddress || 'unknown';
}

/* ───────────── Límite de intentos ───────────── */

const attemptKey = (kind, value) => `${kind}:${digest(String(value))}`;

async function assertNotLocked(db, keys, now) {
    const rows = await db.collection('login_attempts').find({ _id: { $in: keys } }).toArray();
    const until = Math.max(0, ...rows.map(row => row.lockedUntil ? new Date(row.lockedUntil).getTime() : 0));
    if (until > now) {
        const minutes = Math.ceil((until - now) / 60_000);
        throw new HttpError(429, `Demasiados intentos. Probá de nuevo en ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.`, 'TOO_MANY_ATTEMPTS');
    }
}

/** Suma un intento dentro de una ventana de 15 minutos; al llegar al máximo, bloquea 15 minutos. */
async function countAttempt(db, key, max, now) {
    const attempts = db.collection('login_attempts');
    const row = await attempts.findOne({ _id: key });
    const fresh = !row || now - new Date(row.windowStart).getTime() > LOCK_MS || (row.lockedUntil && new Date(row.lockedUntil).getTime() <= now);
    const count = (fresh ? 0 : row.count) + 1;
    const locked = count >= max;
    await attempts.updateOne({ _id: key }, {
        $set: {
            count: locked ? 0 : count,
            windowStart: fresh ? new Date(now) : row.windowStart,
            lockedUntil: locked ? new Date(now + LOCK_MS) : null,
            expiresAt: new Date(now + 2 * LOCK_MS),
        },
    }, { upsert: true });
}

const clearAttempts = (db, key) => db.collection('login_attempts').deleteOne({ _id: key });

/* ───────────── Dispositivos ───────────── */

function cleanDevice(input) {
    if (!input || typeof input !== 'object' || input.platform !== 'ios') return null;
    return { name: cleanName(input.name).slice(0, 60) || 'iPhone', platform: 'ios' };
}

export async function createDevice(db, user, info, now) {
    const token = newToken();
    const device = {
        _id: digest(token), publicId: randomUUID(), userId: user._id, name: info.name, platform: info.platform,
        lockAfterMs: DEFAULT_LOCK_MS, failures: 0, createdAt: new Date(now), lastUsedAt: new Date(now),
    };
    await db.collection('devices').insertOne(device);
    return { token, device };
}

export const publicDevice = (device, currentId = null) => device && {
    id: device.publicId, name: device.name, platform: device.platform, lockAfterMs: device.lockAfterMs ?? DEFAULT_LOCK_MS,
    createdAt: device.createdAt, lastUsedAt: device.lastUsedAt, current: currentId != null && device._id === currentId,
    location: device.location ?? null,
};

export async function listDevices(db, user) {
    const devices = await db.collection('devices').find({ userId: user._id }).toArray();
    return devices.sort((a, b) => new Date(b.lastUsedAt) - new Date(a.lastUsedAt)).map(device => publicDevice(device, user.deviceId ?? null));
}

/** Desvincula un dispositivo y cierra sus sesiones. */
export async function revokeDevice(db, user, id) {
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id)) throw new HttpError(400, 'Dispositivo inválido.');
    const device = await db.collection('devices').findOne({ publicId: id, userId: user._id });
    if (!device) throw new HttpError(404, 'No se encontró el dispositivo.');
    await db.collection('devices').deleteOne({ _id: device._id });
    await db.collection('sessions').deleteMany({ deviceId: device._id });
    return { ok: true, current: device._id === user.deviceId };
}

export async function updateCurrentDevice(db, user, body) {
    if (!user.deviceId) throw new HttpError(400, 'Esta opción es solo para la app de iOS.');
    const lockAfterMs = Number(body?.lockAfterMs);
    if (!LOCK_OPTIONS.includes(lockAfterMs)) throw new HttpError(400, 'Elegí un tiempo válido.');
    const device = await db.collection('devices').findOneAndUpdate({ _id: user.deviceId, userId: user._id }, { $set: { lockAfterMs } }, { returnDocument: 'after' });
    if (!device) throw new HttpError(404, 'Este iPhone ya no está vinculado.', 'DEVICE_UNKNOWN');
    return { device: publicDevice(device, user.deviceId) };
}

/* ───────────── Registro e ingreso ───────────── */

function checkNewPin(pin, confirmPin) {
    if (!validPin(pin)) throw new HttpError(400, 'El PIN debe tener 6 dígitos.');
    if (weakPin(pin)) throw new HttpError(400, 'Ese PIN es muy fácil de adivinar. Evitá números repetidos o seguidos.', 'WEAK_PIN');
    if (pin !== confirmPin) throw new HttpError(400, 'Los PINs no coinciden.');
}

function checkNewPassword(password, confirmPassword, email) {
    if (!validPassword(password)) throw new HttpError(400, PASSWORD_RULE, 'WEAK_PASSWORD');
    if (email && password.toLowerCase().includes(email.split('@')[0]) && email.split('@')[0].length >= 4) throw new HttpError(400, 'La contraseña no puede contener tu correo.', 'WEAK_PASSWORD');
    if (password !== confirmPassword) throw new HttpError(400, 'Las contraseñas no coinciden.');
}

export async function register(db, body, ip, now) {
    const name = cleanName(body?.name);
    const email = normalizeEmail(body?.email);
    if (!validName(name)) throw new HttpError(400, 'Ingresá tu nombre (hasta 60 caracteres).');
    if (!validEmail(email)) throw new HttpError(400, 'Ingresá un correo válido.');
    checkNewPassword(body?.password, body?.confirmPassword, email);
    checkNewPin(body?.pin, body?.confirmPin);
    const ipKey = attemptKey('register', ip);
    await assertNotLocked(db, [ipKey], now);
    await countAttempt(db, ipKey, REGISTER_MAX_PER_IP, now);
    const user = {
        name, email, passwordHash: await hashPassword(body.password), pinHash: await hashPin(body.pin),
        createdAt: new Date(now), passwordChangedAt: new Date(now),
    };
    try { user._id = (await db.collection('users').insertOne(user)).insertedId; }
    catch (error) {
        if (error.code === 11000) throw new HttpError(409, 'Ya existe una cuenta con ese correo. Ingresá con tu contraseña.', 'ACCOUNT_EXISTS');
        throw error;
    }
    const info = cleanDevice(body?.device);
    return { user, linked: info ? await createDevice(db, user, info, now) : null };
}

/**
 * Ingreso con correo y contraseña. Las cuentas creadas antes de las contraseñas entran una
 * única vez con correo y PIN (`legacy: true`) y la app les pide completar nombre y contraseña.
 */
export async function login(db, body, ip, now, env = process.env) {
    const email = normalizeEmail(body?.email);
    const legacy = body?.legacy === true;
    const secret = legacy ? body?.pin : body?.password;
    const generic = legacy ? 'Correo o PIN incorrectos.' : 'Correo o contraseña incorrectos.';
    if (!validEmail(email) || typeof secret !== 'string' || !secret) throw new HttpError(400, legacy ? 'Ingresá tu correo y tu PIN de 6 dígitos.' : 'Ingresá tu correo y tu contraseña.');
    const emailKey = attemptKey('email', email), ipKey = attemptKey('ip', ip);
    await assertNotLocked(db, [emailKey, ipKey], now);
    const user = await db.collection('users').findOne({ email });
    const ok = legacy
        ? !user?.passwordHash && await verifyPin(secret, user?.pinHash)
        : await verifyPassword(secret, user?.passwordHash);
    if (!ok || !user || user.disabled) {
        await countAttempt(db, emailKey, LOGIN_MAX_FAILURES, now);
        await countAttempt(db, ipKey, IP_MAX_FAILURES, now);
        throw new HttpError(401, generic, 'INVALID_CREDENTIALS');
    }
    if (await db.collection('mfa').findOne({ _id: user._id, enabled: true })) {
        if (!body?.mfaCode) throw new HttpError(401, 'Ingresá el código de tu autenticador o uno de respaldo.', 'MFA_REQUIRED');
        if (!await verifyMfa(db, user._id, body.mfaCode, env, now)) {
            await countAttempt(db, emailKey, LOGIN_MAX_FAILURES, now);
            await countAttempt(db, ipKey, IP_MAX_FAILURES, now);
            throw new HttpError(401, 'El código no es válido o ya se usó.', 'MFA_INVALID');
        }
    }
    await clearAttempts(db, emailKey);
    const info = cleanDevice(body?.device);
    return { user, linked: info ? await createDevice(db, user, info, now) : null };
}

/** Desbloqueo con el secreto del iPhone + PIN. */
export async function unlock(db, body, now) {
    const token = body?.deviceToken;
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) throw new HttpError(401, 'Este iPhone ya no está vinculado. Ingresá con tu correo y contraseña.', 'DEVICE_UNKNOWN');
    if (!validPin(body?.pin)) throw new HttpError(400, 'Ingresá tu PIN de 6 dígitos.');
    const devices = db.collection('devices');
    const device = await devices.findOne({ _id: digest(token) });
    const user = device && await db.collection('users').findOne({ _id: device.userId, disabled: { $ne: true } });
    if (!device || !user) throw new HttpError(401, 'Este iPhone ya no está vinculado. Ingresá con tu correo y contraseña.', 'DEVICE_UNKNOWN');
    if (await verifyPin(body.pin, user.pinHash)) {
        const updated = await devices.findOneAndUpdate({ _id: device._id }, { $set: { failures: 0, lastUsedAt: new Date(now) } }, { returnDocument: 'after' });
        return { user, device: updated ?? device };
    }
    const updated = await devices.findOneAndUpdate({ _id: device._id }, { $inc: { failures: 1 } }, { returnDocument: 'after' });
    const failures = updated?.failures ?? DEVICE_MAX_FAILURES;
    if (failures >= DEVICE_MAX_FAILURES) {
        await devices.deleteOne({ _id: device._id });
        await db.collection('sessions').deleteMany({ deviceId: device._id });
        throw new HttpError(401, 'Demasiados PINs incorrectos. Por seguridad desvinculamos este iPhone: ingresá con tu correo y contraseña.', 'DEVICE_REVOKED');
    }
    const left = DEVICE_MAX_FAILURES - failures;
    throw new HttpError(401, `PIN incorrecto. Te ${left === 1 ? 'queda 1 intento' : `quedan ${left} intentos`}.`, 'INVALID_PIN');
}

/** Cuentas viejas (solo PIN): completan nombre y contraseña una vez. */
export async function completeSetup(db, user, body, now) {
    const current = await db.collection('users').findOne({ _id: user._id }, { projection: { passwordHash: 1, email: 1 } });
    if (current?.passwordHash) throw new HttpError(409, 'Tu cuenta ya tiene contraseña.', 'ALREADY_SET');
    const name = cleanName(body?.name);
    if (!validName(name)) throw new HttpError(400, 'Ingresá tu nombre (hasta 60 caracteres).');
    checkNewPassword(body?.password, body?.confirmPassword, current?.email);
    await db.collection('users').updateOne({ _id: user._id }, { $set: { name, passwordHash: await hashPassword(body.password), passwordChangedAt: new Date(now) } });
    return { ok: true, name };
}

/** Cambio de contraseña: cierra las demás sesiones y desvincula los demás dispositivos. */
export async function changePassword(db, user, body, currentToken, now) {
    const key = attemptKey('password', user._id.toString());
    await assertNotLocked(db, [key], now);
    const current = await db.collection('users').findOne({ _id: user._id }, { projection: { passwordHash: 1, email: 1 } });
    if (!await verifyPassword(body?.currentPassword, current?.passwordHash)) {
        await countAttempt(db, key, LOGIN_MAX_FAILURES, now);
        throw new HttpError(401, 'La contraseña actual es incorrecta.', 'INVALID_CREDENTIALS');
    }
    await clearAttempts(db, key);
    checkNewPassword(body?.newPassword, body?.confirmPassword, current.email);
    if (body.newPassword === body.currentPassword) throw new HttpError(400, 'Elegí una contraseña distinta de la actual.');
    await db.collection('users').updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date(now) } });
    await db.collection('password_recovery').deleteOne({ _id: user._id });
    await db.collection('known_browsers').deleteMany({ userId: user._id });
    await db.collection('devices').deleteMany({ userId: user._id, _id: { $ne: user.deviceId ?? null } });
    await db.collection('sessions').deleteMany({ userId: user._id, _id: { $ne: currentToken ? digest(currentToken) : null } });
    return { ok: true };
}

/** Solo una sesión abierta puede generar un código; se guarda únicamente su hash. */
export async function createRecoveryCode(db, user, now) {
    const code = randomBytes(6).toString('hex').toUpperCase();
    const expiresAt = new Date(now + 10 * 60_000);
    await db.collection('password_recovery').updateOne({ _id: user._id }, { $set: { codeHash: digest(code), expiresAt } }, { upsert: true });
    return { code, expiresAt };
}

/** Correo + PIN + código de la sesión web; el código se consume de forma atómica. */
export async function recoverPassword(db, body, ip, now) {
    const email = normalizeEmail(body?.email);
    const pin = body?.pin;
    const code = typeof body?.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (!validEmail(email) || !validPin(pin) || !/^[A-F0-9]{12}$/.test(code)) throw new HttpError(400, 'Revisá el correo, el PIN de 6 dígitos y el código de 12 caracteres.');
    checkNewPassword(body?.newPassword, body?.confirmPassword, email);
    const emailKey = attemptKey('recover', email), ipKey = attemptKey('recover-ip', ip);
    await assertNotLocked(db, [emailKey, ipKey], now);
    const user = await db.collection('users').findOne({ email });
    const pinMatches = await verifyPin(pin, user?.pinHash);
    const passwordHash = await hashPassword(body.newPassword);
    // Una sola solicitud puede consumir un código válido, aun si llegan varias a la vez.
    const consumed = pinMatches && user && !user.disabled
        ? await db.collection('password_recovery').findOneAndDelete({ _id: user._id, codeHash: digest(code), expiresAt: { $gt: new Date(now) } })
        : null;
    if (!consumed) {
        await countAttempt(db, emailKey, LOGIN_MAX_FAILURES, now);
        await countAttempt(db, ipKey, IP_MAX_FAILURES, now);
        throw new HttpError(401, 'No se pudo verificar el correo, el PIN y el código. Revisalos o generá otro código.', 'INVALID_CREDENTIALS');
    }
    await db.collection('users').updateOne({ _id: user._id }, { $set: { passwordHash, passwordChangedAt: new Date(now) } });
    await db.collection('devices').deleteMany({ userId: user._id });
    await db.collection('known_browsers').deleteMany({ userId: user._id });
    await db.collection('sessions').deleteMany({ userId: user._id });
    await clearAttempts(db, emailKey);
    return { ok: true };
}

export { checkNewPin };
