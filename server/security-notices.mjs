import { deliverNotification } from './push.mjs';
import { digest } from './security.mjs';

/** El identificador del navegador solo sirve para reconocerlo; nunca autentica. */
export async function notifyNewLogin(db, user, body, env, now, deliver = deliverNotification) {
    let known = false;
    if (typeof body?.previousDeviceToken === 'string' && /^[\w-]{43}$/.test(body.previousDeviceToken)) {
        known = !!await db.collection('devices').findOne({ _id: digest(body.previousDeviceToken), userId: user._id });
    }
    const browser = typeof body?.browserId === 'string' && /^(?:[a-f0-9]{64}|[\w-]{43})$/.test(body.browserId) ? digest(body.browserId) : null;
    if (browser && !body?.device) {
        known = !!await db.collection('known_browsers').findOne({ userId: user._id, browser });
        await db.collection('known_browsers').updateOne({ userId: user._id, browser }, { $set: { lastUsedAt: new Date(now) }, $setOnInsert: { createdAt: new Date(now) } }, { upsert: true });
    }
    if (known) return;
    const rows = await db.collection('push_subscriptions').find({ userId: user._id }).toArray();
    const telegram = env.TELEGRAM_BOT_TOKEN ? await db.collection('telegram_subscriptions').findOne({ _id: user._id }) : null;
    if (telegram) rows.push({ ...telegram, channel: 'telegram' });
    const label = body?.device?.platform === 'ios' ? 'un iPhone' : 'un navegador';
    const payload = { title: 'Nuevo inicio de sesión', body: `Se inició sesión en tu cuenta desde ${label} que no reconocemos. Si no fuiste vos, cambiá tu contraseña.`, url: '/ajustes/seguridad' };
    await Promise.allSettled(rows.map(row => deliver(db, row, payload, env)));
}
