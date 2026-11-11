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
        if (!i || !text(i.id, 128) || ids.has(i.id) || !text(i.name, 70) || !(positive(i.amount) || (i.kind === 'crypto' && i.costUnknown === true && i.amount === 0))) return invalid();
        if (i.costUnknown !== undefined && (i.costUnknown !== true || i.kind !== 'crypto' || i.amount !== 0)) return invalid();
        ids.add(i.id);
        if (!['USD', 'ARS'].includes(i.currency) || !['rate', 'cedear', 'crypto', 'stock', 'arg-stock', 'bond', 'fund', 'morpho'].includes(i.kind)) return invalid();
        if ((i.kind === 'stock' && i.currency !== 'USD') || (['arg-stock', 'bond', 'fund'].includes(i.kind) && i.currency !== 'ARS')) return invalid();
        if (typeof i.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(i.date)) return invalid();
        const date = new Date(`${i.date}T12:00:00Z`);
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== i.date) return invalid();
        const item = { id: i.id, name: i.name.trim(), amount: i.amount, currency: i.currency, date: i.date, kind: i.kind, ...(i.costUnknown === true ? { costUnknown: true } : {}) };
        if (i.kind === 'rate') {
            if (typeof i.rate !== 'number' || !Number.isFinite(i.rate) || i.rate <= -100 || !['month', 'year'].includes(i.period)) return invalid();
            if (i.maturityDate != null) {
                if (i.rate < 0 || i.period !== 'year' || typeof i.maturityDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(i.maturityDate)) return invalid();
                const maturity = new Date(`${i.maturityDate}T12:00:00Z`);
                if (!Number.isFinite(maturity.getTime()) || maturity.toISOString().slice(0, 10) !== i.maturityDate || i.maturityDate <= i.date) return invalid();
            }
            return { ...item, rate: i.rate, period: i.period, ...(i.maturityDate == null ? {} : { maturityDate: i.maturityDate }) };
        }
        if (!text(i.coin, 150) || !positive(i.units)) return invalid();
        if ((i.purchasePrice != null && !positive(i.purchasePrice)) || (i.purchaseFx != null && !positive(i.purchaseFx))) return invalid();
        return { ...item, coin: i.coin, units: i.units, ...(i.purchasePrice != null ? { purchasePrice: i.purchasePrice } : {}), ...(i.purchaseFx != null ? { purchaseFx: i.purchaseFx } : {}) };
    });
    const sales = raw.sales ?? [];
    if (!Array.isArray(sales) || sales.length > 10000) return invalid();
    for (const s of sales) {
        if (!s || !text(s.id, 128) || !text(s.name, 70) || typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date) || !positive(s.fraction) || s.fraction > 1 || !positive(s.proceeds) || !positive(s.cost) || !['ARS', 'USD'].includes(s.currency) || !['ARS', 'USD'].includes(s.costCurrency)) return invalid();
        if ((s.executionPrice != null && !positive(s.executionPrice)) || (s.units != null && !positive(s.units)) || (s.fee != null && (typeof s.fee !== 'number' || !Number.isFinite(s.fee) || s.fee < 0))) return invalid();
        const date = new Date(`${s.date}T12:00:00Z`);
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== s.date) return invalid();
    }
    const imports = raw.imports ?? [];
    if (!Array.isArray(imports) || imports.length > 5000) return invalid();
    const importIds = new Set();
    const importFields = ['source', 'asset', 'name', 'kind', 'side', 'date', 'quantity', 'price', 'amount', 'currency', 'fee', 'externalId', 'executions'];
    for (const op of imports) {
        if (!op || !text(op.id, 128) || importIds.has(op.id) || !['pending', 'confirmed', 'discarded'].includes(op.status)) return invalid();
        importIds.add(op.id);
        if (importFields.some(field => typeof op[field] !== 'string' || op[field].length > (field === 'executions' ? 20000 : 300))) return invalid();
    }
    const alerts = raw.alerts ?? [];
    if (!Array.isArray(alerts) || alerts.length > 200) return invalid();
    const alertIds = new Set();
    for (const a of alerts) {
        if (!a || !text(a.id, 128) || alertIds.has(a.id) || !['price', 'variation', 'concentration', 'dividend', 'maturity'].includes(a.kind) || !['cedear', 'stock', 'crypto', 'arg-stock', 'bond', 'fund'].includes(a.assetKind) || !text(a.assetId, 150) || !text(a.assetName, 150) || !['above', 'below'].includes(a.direction) || typeof a.threshold !== 'number' || !Number.isFinite(a.threshold) || a.threshold < 0 || a.threshold > 1e15 || typeof a.date !== 'string') return invalid();
        if (['dividend', 'maturity'].includes(a.kind) ? !Number.isInteger(a.threshold) : a.threshold === 0) return invalid();
        if (a.kind === 'concentration' && a.threshold > 100) return invalid();
        if (a.channels !== undefined && !['push', 'telegram', 'both'].includes(a.channels)) return invalid();
        if (a.kind === 'maturity') { const date = new Date(`${a.date}T12:00:00Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== a.date) return invalid(); }
        else if (a.date !== '') return invalid();
        alertIds.add(a.id);
    }
    const p = raw.preferences;
    if (!p || !['dark', 'light', 'system'].includes(p.theme) || !['USD', 'ARS'].includes(p.display)
        || !['bolsa', 'contadoconliqui', 'blue', 'oficial', 'mayorista', 'cripto', 'tarjeta'].includes(p.dollar)
        || typeof p.hidden !== 'boolean' || typeof p.sidebarCollapsed !== 'boolean' || ![0, 12, 36, 60].includes(p.horizon)) return invalid();
    if ((p.showChatButton !== undefined && typeof p.showChatButton !== 'boolean') || (p.showQuotesBar !== undefined && typeof p.showQuotesBar !== 'boolean')) return invalid();
    if (p.quietHours !== undefined && (!p.quietHours || typeof p.quietHours !== 'object' || typeof p.quietHours.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.quietHours.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.quietHours.end) || (p.quietHours.enabled && p.quietHours.start === p.quietHours.end))) return invalid();
    if (p.rateAlerts !== undefined && (!p.rateAlerts || typeof p.rateAlerts !== 'object' || typeof p.rateAlerts.enabled !== 'boolean' || !['push', 'telegram', 'both'].includes(p.rateAlerts.channels))) return invalid();
    let allocationTargets;
    if (p.allocationTargets !== undefined) {
        const keys = ['rate', 'cedear', 'index', 'stock', 'crypto'];
        const optionalKeys = ['arg-stock', 'bond', 'fund', 'morpho'];
        const targets = p.allocationTargets;
        if (!targets || typeof targets !== 'object' || Array.isArray(targets) || Object.keys(targets).some(key => ![...keys, ...optionalKeys].includes(key)) || keys.some(key => !(key in targets)) || [...keys, ...optionalKeys].some(key => targets[key] !== undefined && (typeof targets[key] !== 'number' || !Number.isFinite(targets[key]) || targets[key] < 0 || targets[key] > 100))) return invalid();
        const withoutMorpho = [...keys, 'arg-stock', 'bond', 'fund'].reduce((sum, key) => sum + (targets[key] ?? 0), 0);
        const hasMorpho = Object.prototype.hasOwnProperty.call(targets, 'morpho');
        const morpho = hasMorpho ? targets.morpho : Math.max(0, 100 - withoutMorpho);
        if ((!hasMorpho && withoutMorpho > 100.000001) || Math.abs(withoutMorpho + (morpho ?? 0) - 100) > 0.000001) return invalid();
        allocationTargets = { rate: targets.rate, cedear: targets.cedear, index: targets.index, stock: targets.stock, crypto: targets.crypto, ...(targets['arg-stock'] === undefined ? {} : { 'arg-stock': targets['arg-stock'] }), ...(targets.bond === undefined ? {} : { bond: targets.bond }), ...(targets.fund === undefined ? {} : { fund: targets.fund }), ...(!hasMorpho && morpho === 0 ? {} : { morpho }) };
    }
    if (p.panels !== undefined && (!Array.isArray(p.panels) || p.panels.some(x => !['value', 'evolution', 'distribution', 'investments', 'inflation', 'macro', 'streak', 'panel-v2'].includes(x)))) return invalid();
    return { investments, ...(raw.alerts === undefined ? {} : { alerts: alerts.map(({ id, kind, assetKind, assetId, assetName, threshold, direction, date, channels }) => ({ id, kind, assetKind, assetId, assetName, threshold, direction, date, ...(channels === undefined ? {} : { channels }) })) }), ...(raw.imports === undefined ? {} : { imports: imports.map(op => ({ id: op.id, status: op.status, ...Object.fromEntries(importFields.map(field => [field, op[field]])) })) }), ...(raw.sales === undefined ? {} : { sales: sales.map(({ id, name, date, fraction, proceeds, currency, cost, costCurrency, executionPrice, units, fee }) => ({ id, name, date, fraction, proceeds, currency, cost, costCurrency, ...(executionPrice == null ? {} : { executionPrice }), ...(units == null ? {} : { units }), ...(fee == null ? {} : { fee }) })) }), preferences: { ...(allocationTargets === undefined ? {} : { allocationTargets }), theme: p.theme, display: p.display, dollar: p.dollar, hidden: p.hidden, sidebarCollapsed: p.sidebarCollapsed, horizon: p.horizon, ...(p.panels === undefined ? {} : { panels: p.panels }), ...(p.showChatButton === undefined ? {} : { showChatButton: p.showChatButton }), ...(p.showQuotesBar === undefined ? {} : { showQuotesBar: p.showQuotesBar }), ...(p.quietHours === undefined ? {} : { quietHours: { enabled: p.quietHours.enabled, start: p.quietHours.start, end: p.quietHours.end } }), ...(p.rateAlerts === undefined ? {} : { rateAlerts: { enabled: p.rateAlerts.enabled, channels: p.rateAlerts.channels } }) } };
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
