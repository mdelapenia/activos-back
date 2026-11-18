import { HttpError } from './security.mjs';

// Buscador de Mercado: favoritos y búsquedas recientes de cada persona, en su cuenta (no en el dispositivo).
// Un documento por usuario en `market_saved`; cada campo se guarda por separado para que no se pisen.
export const MAX_FAVORITES = 100;
export const MAX_RECENT_SEARCHES = 8;
const KINDS = ['cedear', 'stock', 'arg-stock', 'crypto', 'fund', 'bond', 'lecap', 'morpho'];
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const invalid = () => { throw new HttpError(400, 'Los favoritos o las búsquedas recientes no son válidos.'); };

function cleanFavorites(raw) {
    if (!Array.isArray(raw) || raw.length > MAX_FAVORITES) invalid();
    const seen = new Set();
    return raw.map(a => {
        if (!a || !KINDS.includes(a.assetKind) || !text(a.assetId, 150) || !text(a.assetName, 150) || !text(a.symbol, 60)) invalid();
        const key = `${a.assetKind}:${a.assetId.toLowerCase()}`;
        if (seen.has(key)) invalid();
        seen.add(key);
        return { assetKind: a.assetKind, assetId: a.assetId, assetName: a.assetName, symbol: a.symbol };
    });
}

function cleanRecent(raw) {
    if (!Array.isArray(raw) || raw.length > MAX_RECENT_SEARCHES || raw.some(item => !text(item, 150))) invalid();
    return raw.map(item => item.trim());
}

const view = row => ({ favorites: row?.favorites ?? [], recentSearches: row?.recentSearches ?? [] });

/** GET (data = null) devuelve lo guardado; PUT guarda solo los campos enviados. */
export async function marketSaved(db, user, data, now = Date.now()) {
    const collection = db.collection('market_saved');
    if (data === null) return view(await collection.findOne({ _id: user._id }));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['favorites', 'recentSearches'].includes(key)) || (data.favorites === undefined && data.recentSearches === undefined)) invalid();
    const set = { updatedAt: new Date(now) };
    if (data.favorites !== undefined) set.favorites = cleanFavorites(data.favorites);
    if (data.recentSearches !== undefined) set.recentSearches = cleanRecent(data.recentSearches);
    await collection.updateOne({ _id: user._id }, { $set: set }, { upsert: true });
    return view(await collection.findOne({ _id: user._id }));
}
