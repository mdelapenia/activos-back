import { HttpError } from './security.mjs';

export const emptyPortfolio = () => ({
    investments: [],
    preferences: { theme: 'dark', dollar: 'bolsa', hidden: false, sidebarCollapsed: false, display: 'USD', horizon: 12 },
});

const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
const text = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const invalid = () => { throw new HttpError(400, 'Los datos de la cartera no son válidos.', 'INVALID_PORTFOLIO'); };

export function validatePortfolio(raw) {
    if (!raw || !Array.isArray(raw.investments) || raw.investments.length > 5000) return invalid();
    const ids = new Set();
    const investments = raw.investments.map(i => {
        if (!i || !text(i.id, 128) || ids.has(i.id) || !text(i.name, 70) || !positive(i.amount)) return invalid();
        ids.add(i.id);
        if (!['USD', 'ARS'].includes(i.currency) || !['rate', 'cedear', 'crypto'].includes(i.kind)) return invalid();
        if (typeof i.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(i.date)) return invalid();
        const date = new Date(`${i.date}T12:00:00Z`);
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== i.date) return invalid();
        const item = { id: i.id, name: i.name.trim(), amount: i.amount, currency: i.currency, date: i.date, kind: i.kind };
        if (i.kind === 'rate') {
            if (typeof i.rate !== 'number' || !Number.isFinite(i.rate) || i.rate <= -100 || !['month', 'year'].includes(i.period)) return invalid();
            return { ...item, rate: i.rate, period: i.period };
        }
        if (!text(i.coin, 150) || !positive(i.units)) return invalid();
        if ((i.purchasePrice != null && !positive(i.purchasePrice)) || (i.purchaseFx != null && !positive(i.purchaseFx))) return invalid();
        return { ...item, coin: i.coin, units: i.units, ...(i.purchasePrice != null ? { purchasePrice: i.purchasePrice } : {}), ...(i.purchaseFx != null ? { purchaseFx: i.purchaseFx } : {}) };
    });
    const sales = raw.sales ?? [];
    if (!Array.isArray(sales) || sales.length > 10000) return invalid();
    for (const s of sales) {
        if (!s || !text(s.id, 128) || !text(s.name, 70) || typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date) || !positive(s.fraction) || s.fraction > 1 || !positive(s.proceeds) || !positive(s.cost) || !['ARS', 'USD'].includes(s.currency) || !['ARS', 'USD'].includes(s.costCurrency)) return invalid();
        const date = new Date(`${s.date}T12:00:00Z`);
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== s.date) return invalid();
    }
    const p = raw.preferences;
    if (!p || !['dark', 'light', 'system'].includes(p.theme) || !['USD', 'ARS'].includes(p.display)
        || !['bolsa', 'contadoconliqui', 'blue', 'oficial', 'mayorista', 'cripto', 'tarjeta'].includes(p.dollar)
        || typeof p.hidden !== 'boolean' || typeof p.sidebarCollapsed !== 'boolean' || ![0, 12, 36, 60].includes(p.horizon)) return invalid();
    if (p.panels !== undefined && (!Array.isArray(p.panels) || p.panels.some(x => !['value', 'evolution', 'distribution', 'investments', 'inflation', 'macro', 'streak', 'panel-v2'].includes(x)))) return invalid();
    return { investments, ...(raw.sales === undefined ? {} : { sales: sales.map(({ id, name, date, fraction, proceeds, currency, cost, costCurrency }) => ({ id, name, date, fraction, proceeds, currency, cost, costCurrency })) }), preferences: { theme: p.theme, display: p.display, dollar: p.dollar, hidden: p.hidden, sidebarCollapsed: p.sidebarCollapsed, horizon: p.horizon, ...(p.panels === undefined ? {} : { panels: p.panels }) } };
}

export async function readPortfolio(db, userId) {
    const doc = await db.collection('portfolios').findOne({ _id: userId });
    return doc ? { portfolio: doc.portfolio, version: doc.version, mutationId: doc.mutationId } : { portfolio: emptyPortfolio(), version: 0, mutationId: null };
}

export async function writePortfolio(db, userId, body) {
    if (!body || !Number.isSafeInteger(body.version) || body.version < 0
        || typeof body.mutationId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.mutationId)) return invalid();
    const portfolio = validatePortfolio(body.portfolio);
    const collection = db.collection('portfolios');
    const doc = { portfolio, version: body.version + 1, mutationId: body.mutationId, updatedAt: new Date() };
    try {
        if (body.version === 0) {
            await collection.insertOne({ _id: userId, ...doc });
            return { version: doc.version, mutationId: doc.mutationId };
        }
        const result = await collection.updateOne({ _id: userId, version: body.version }, { $set: doc });
        if (result.matchedCount) return { version: doc.version, mutationId: doc.mutationId };
    } catch (error) {
        if (error.code !== 11000) throw error;
    }
    const latest = await collection.findOne({ _id: userId });
    // Repetir una solicitud cuya respuesta se perdió no vuelve a aplicar el cambio.
    if (latest?.mutationId === body.mutationId && latest.version === body.version + 1) return { version: latest.version, mutationId: latest.mutationId };
    throw new HttpError(409, 'Tu cartera cambió en otra pestaña o dispositivo. Recargá la versión guardada antes de continuar.', 'CONFLICT');
}
