import { HttpError } from './security.mjs';

const levels = ['nuevo', 'intermedio', 'avanzado'];
const frequencies = ['diario', 'semanal', 'aveces'];
const featureIds = ['cartera', 'evolucion', 'dividendos', 'alertas', 'importar', 'objetivos', 'widgets', 'notificaciones', 'ia', 'telegram', 'apariencia', 'seguridad'];
const brokerNames = ['IOL', 'Balanz', 'Cocos', 'Bull Market', 'Binance', 'Lemon', 'Otro'];

function text(value, max, required = false) {
    if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw new HttpError(400, 'Revisá los datos ingresados.');
    return value.trim();
}
function selections(value, allowed) {
    if (!Array.isArray(value) || value.some(item => !allowed.includes(item))) throw new HttpError(400, 'Revisá las opciones elegidas.');
    return [...new Set(value)];
}

export async function saveBetaSignup(db, user, body, now) {
    const name = text(body?.name, 120, true);
    const email = text(body?.email, 120, true).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !levels.includes(body?.level) || !frequencies.includes(body?.frequency) || body?.accepts !== true || typeof body?.contact !== 'boolean') throw new HttpError(400, 'Revisá los datos y la confirmación.');
    const data = { name, email, device: text(body.device, 120), level: body.level, frequency: body.frequency, features: selections(body.features, featureIds), brokers: selections(body.brokers, brokerNames), contact: body.contact, comment: text(body.comment, 500), updatedAt: new Date(now) };
    await db.collection('beta_signups').updateOne({ _id: user._id }, { $set: data, $setOnInsert: { createdAt: new Date(now) } }, { upsert: true });
    return { ok: true };
}

export async function saveBetaFeedback(db, user, body, now) {
    if (!['error', 'idea'].includes(body?.type)) throw new HttpError(400, 'Elegí si querés informar un error o compartir una idea.');
    const message = text(body.message, 2000, true);
    const area = text(body.area, 120);
    const device = text(body.device, 120);
    await db.collection('beta_feedback').insertOne({ userId: user._id, email: user.email, type: body.type, area, message, device, createdAt: new Date(now) });
    return { ok: true };
}
