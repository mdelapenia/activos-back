import { gmailDisconnect } from './gmail-import.mjs';
import { checkPin } from './pin-guard.mjs';

/**
 * Elimina la cuenta y todos sus datos (requisito del App Store, guía 5.1.1(v)).
 * Pide el PIN para que nadie la borre con un teléfono desbloqueado ajeno.
 *
 * Se borra todo lo vinculado a la persona. Quedan solo registros sin datos personales que
 * vencen solos: las marcas de envíos ya hechos (`push_deliveries`, `summary_deliveries`, hash + fecha)
 * y las solicitudes OAuth anónimas sin completar (`oauth_requests`).
 */
export const USER_DATA = [
    // [colección, campo que guarda el id de la persona]
    ['portfolios', '_id'],
    ['scheduled_summaries', '_id'],
    ['summary_snapshots', 'userId'],
    ['push_subscriptions', 'userId'],
    ['telegram_subscriptions', '_id'],
    ['telegram_link_codes', 'userId'],
    ['wallet_addresses', 'userId'],
    ['passkeys', 'userId'],
    ['passkey_challenges', 'userId'],
    ['gmail_connections', '_id'],
    ['gmail_oauth_states', 'userId'],
    ['resend_import_aliases', '_id'],
    ['oauth_grants', 'userId'],
    ['oauth_codes', 'userId'],
    ['oauth_access_tokens', 'userId'],
    ['oauth_refresh_tokens', 'userId'],
    ['pin_attempts', '_id'],
    ['sessions', 'userId'],
];

export async function deleteAccount(db, user, body, env, { revokeGmail = gmailDisconnect, now = Date.now() } = {}) {
    await checkPin(db, user, body?.pin, now, { field: 'tu PIN' });

    // Primero se revoca el acceso a Gmail en Google (si estaba conectado), para no dejar un permiso vivo.
    // Si Google no responde se sigue igual: el token se borra de la base y deja de poder usarse.
    try { await revokeGmail(db, user, env); } catch { /* Se elimina igual más abajo. */ }

    for (const [name, field] of USER_DATA) await db.collection(name).deleteMany({ [field]: user._id });
    // La cuenta va al final: si algo falla antes, la persona puede reintentar con su sesión.
    await db.collection('users').deleteOne({ _id: user._id });
    return { ok: true };
}
