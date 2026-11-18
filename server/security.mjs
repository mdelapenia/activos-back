import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const options = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
export const validPin = pin => typeof pin === 'string' && /^\d{6}$/.test(pin);
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 128;
export const PASSWORD_RULE = `La contraseña debe tener entre ${MIN_PASSWORD} y ${MAX_PASSWORD} caracteres.`;
export const validPassword = password => typeof password === 'string' && password.length >= MIN_PASSWORD && password.length <= MAX_PASSWORD && password.trim().length > 0;
/** Nombre visible de la cuenta: sin espacios de más y sin caracteres de control. */
export const cleanName = name => typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() : '';
export const validName = name => { const clean = cleanName(name); return clean.length >= 1 && clean.length <= 60; };
/** PINs fáciles de adivinar: todos iguales (111111) o seguidos (123456, 654321). */
export function weakPin(pin) {
    if (!validPin(pin)) return true;
    if (/^(\d)\1{5}$/.test(pin)) return true;
    const digits = [...pin].map(Number);
    const steps = digits.slice(1).map((d, i) => d - digits[i]);
    return steps.every(step => step === 1) || steps.every(step => step === -1);
}
export const normalizeEmail = email => typeof email === 'string' ? email.trim().toLowerCase() : '';
export const validEmail = email => typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

async function hashSecret(secret) {
    const salt = randomBytes(16).toString('hex');
    const hash = await derive(secret, salt, 32, options);
    return `scrypt-v1$${salt}$${hash.toString('hex')}`;
}

// Hace el mismo trabajo aunque no haya hash guardado: así no se revela por tiempo de respuesta si la cuenta existe.
async function verifySecret(secret, stored, acceptable) {
    const parts = typeof stored === 'string' ? stored.split('$') : [];
    const valid = parts.length === 3 && parts[0] === 'scrypt-v1' && /^[a-f0-9]{32}$/.test(parts[1]) && /^[a-f0-9]{64}$/.test(parts[2]);
    const actual = await derive(acceptable ? secret : 'invalid', valid ? parts[1] : '0'.repeat(32), 32, options);
    const expected = Buffer.from(valid ? parts[2] : '0'.repeat(64), 'hex');
    return timingSafeEqual(actual, expected) && valid && acceptable;
}

export async function hashPin(pin) {
    if (!validPin(pin)) throw new Error('El PIN debe tener 6 dígitos.');
    return hashSecret(pin);
}

export async function verifyPin(pin, stored) {
    return verifySecret(validPin(pin) ? pin : 'invalid', stored, validPin(pin));
}

export async function hashPassword(password) {
    if (!validPassword(password)) throw new Error(PASSWORD_RULE);
    return hashSecret(password);
}

export async function verifyPassword(password, stored) {
    const ok = typeof password === 'string' && password.length > 0 && password.length <= MAX_PASSWORD;
    return verifySecret(ok ? password : 'invalid', stored, ok);
}

export class HttpError extends Error {
    constructor(status, message, code = 'REQUEST_ERROR') {
        super(message);
        this.status = status;
        this.code = code;
    }
}
