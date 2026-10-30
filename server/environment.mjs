import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

export function loadAtlasEnvironment() {
    const file = fileURLToPath(new URL('../../atlas-credentials.env', import.meta.url));
    if (existsSync(file)) {
        const values = parseEnv(readFileSync(file, 'utf8'));
        for (const [key, value] of Object.entries(values)) {
            if (key.startsWith('MONGODB_') && !process.env[key]) process.env[key] = value;
        }
    }
    if (process.env.MONGODB_URI) {
        process.env.MONGODB_URI = process.env.MONGODB_URI
            .replace(/<(?:db_)?username>/g, () => encodeURIComponent(process.env.MONGODB_USERNAME || ''))
            .replace(/<(?:db_)?password>/g, () => encodeURIComponent(process.env.MONGODB_PASSWORD || ''));
    }
}
