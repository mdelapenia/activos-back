import { checkIdleCash } from './iol.mjs';
import { readPortfolio } from './portfolio.mjs';
import { deliverNotification, isQuietHours, notificationSubscriptions } from './push.mjs';
import { isMarketOpen, ratesOverview } from './rates.mjs';

/** Aviso de plata parada en IOL, con la caución del día del radar de tasas. Corre con el resto de los avisos. */
export async function checkIolIdleCash(db, env, now = Date.now()) {
    let all = null;
    return checkIdleCash(db, env, now, {
        marketOpen: isMarketOpen,
        deliver: deliverNotification,
        subscriptions: async userId => {
            all ??= await notificationSubscriptions(db, env, { native: true });
            return all.filter(row => String(row.userId) === String(userId));
        },
        quiet: async (userId, t) => { const { portfolio } = await readPortfolio(db, userId); return isQuietHours(portfolio.preferences?.quietHours, t); },
        rates: async t => (await ratesOverview(db, t)).options.find(option => option.kind === 'caucion') ?? null,
    });
}
