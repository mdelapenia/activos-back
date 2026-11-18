import { deliverNotification, notificationSubscriptions } from './push.mjs';
import { checkOpenOrders, orderPayload } from './trading.mjs';

/** Avisa por push (y Telegram, si está conectado) cada cambio de una orden: enviada, ejecutada o cancelada. */
export function orderNotifier(db, env) {
    let all = null;
    return async (userId, order) => {
        const payload = orderPayload(order);
        if (!payload) return;
        all ??= await notificationSubscriptions(db, env, { native: true });
        for (const row of all.filter(r => String(r.userId) === String(userId))) {
            try { await deliverNotification(db, row, payload, env); } catch (error) { console.error('No se pudo avisar una orden:', error.message); }
        }
    };
}

export async function checkIolOrders(db, env, now = Date.now()) {
    return checkOpenOrders(db, env, now, { notify: orderNotifier(db, env) });
}
