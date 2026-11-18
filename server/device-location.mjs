import { isIP } from 'node:net';
import { digest } from './security.mjs';

/** No se consultan direcciones locales ni se conserva la IP en la base. */
export function publicIp(value) {
    const ip = typeof value === 'string' ? value.trim().replace(/^::ffff:/i, '') : '';
    const version = isIP(ip);
    if (version === 4) {
        const [a, b] = ip.split('.').map(Number);
        if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return null;
        return ip;
    }
    if (version === 6 && ip !== '::' && ip !== '::1' && !/^(f[cd]|fe[89ab]|ff)/i.test(ip)) return ip;
    return null;
}

export async function updateDeviceLocation(db, device, address, { fetcher = fetch } = {}) {
    const ip = publicIp(address);
    if (!device?._id || !ip) return;
    const ipHash = digest(ip);
    if (device.lastIpHash === ipHash && device.location) return;
    try {
        const response = await fetcher(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,region,country&lang=es`, { signal: AbortSignal.timeout(1500) });
        if (!response.ok) return;
        const result = await response.json();
        if (!result?.success) return;
        const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
        const location = { city: clean(result.city), region: clean(result.region), country: clean(result.country) };
        if (!location.city && !location.region && !location.country) return;
        await db.collection('devices').updateOne({ _id: device._id, userId: device.userId }, { $set: { location, lastIpHash: ipHash } });
        device.location = location;
        device.lastIpHash = ipHash;
    } catch { /* El acceso sigue funcionando aunque la ubicación no esté disponible. */ }
}
