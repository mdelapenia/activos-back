import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const options = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
export const validPin = pin => typeof pin === 'string' && /^\d{6}$/.test(pin);
export const normalizeEmail = email => typeof email === 'string' ? email.trim().toLowerCase() : '';
export const validEmail = email => typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export async function hashPin(pin) {
    if (!validPin(pin)) throw new Error('El PIN debe tener 6 dígitos.');
    const salt = randomBytes(16).toString('hex');
    const hash = await derive(pin, salt, 32, options);
    return `scrypt-v1$${salt}$${hash.toString('hex')}`;
}

export async function verifyPin(pin, stored) {
    const parts = typeof stored === 'string' ? stored.split('$') : [];
    const valid = parts.length === 3 && parts[0] === 'scrypt-v1' && /^[a-f0-9]{32}$/.test(parts[1]) && /^[a-f0-9]{64}$/.test(parts[2]);
    // Hacer el mismo trabajo cuando la cuenta no existe evita revelar correos por tiempo de respuesta.
    const actual = await derive(validPin(pin) ? pin : 'invalid', valid ? parts[1] : '0'.repeat(32), 32, options);
    const expected = Buffer.from(valid ? parts[2] : '0'.repeat(64), 'hex');
    return timingSafeEqual(actual, expected) && valid && validPin(pin);
}

export class HttpError extends Error {
    constructor(status, message, code = 'REQUEST_ERROR') {
        super(message);
        this.status = status;
        this.code = code;
    }
}
