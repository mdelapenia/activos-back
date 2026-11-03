import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { newToken, HttpError } from './security.mjs';

function config(env) {
    const origin = env.APP_ORIGIN || (env.NODE_ENV !== 'production' ? 'http://localhost:5173' : '');
    if (!origin) throw new HttpError(503, 'Passkeys no está configurado.');
    const url = new URL(origin);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new HttpError(503, 'Passkeys requiere HTTPS.');
    return { origin: url.origin, rpID: url.hostname };
}
async function saveChallenge(db, type, challenge, now, userId = null) {
    const id = newToken();
    await db.collection('passkey_challenges').insertOne({ _id: id, type, challenge, userId, expiresAt: new Date(now + 300000) });
    return id;
}
async function consume(db, id, type, now, userId = null) {
    if (typeof id !== 'string' || !/^[\w-]{43}$/.test(id)) throw new HttpError(400, 'Solicitud de passkey inválida.');
    const challenge = await db.collection('passkey_challenges').findOneAndDelete({ _id: id, type, userId, expiresAt: { $gt: new Date(now) } });
    if (!challenge) throw new HttpError(400, 'La solicitud venció. Volvé a intentar.');
    return challenge.challenge;
}
export async function registrationOptions(db, user, env, now) {
    const { rpID } = config(env);
    const existing = await db.collection('passkeys').find({ userId: user._id }).toArray();
    const options = await generateRegistrationOptions({ rpName: 'Activos', rpID, userID: new TextEncoder().encode(user._id.toString()), userName: user.email, attestationType: 'none', excludeCredentials: existing.map(c => ({ id: c._id, transports: c.transports })), authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
    return { options, challengeId: await saveChallenge(db, 'registration', options.challenge, now, user._id) };
}
export async function registerPasskey(db, user, body, env, now) {
    const { origin, rpID } = config(env);
    const challenge = await consume(db, body?.challengeId, 'registration', now, user._id);
    let verification;
    try { verification = await verifyRegistrationResponse({ response: body.response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }); }
    catch { throw new HttpError(400, 'No se pudo verificar la passkey.'); }
    if (!verification.verified || !verification.registrationInfo) throw new HttpError(400, 'No se pudo verificar la passkey.');
    const { credential } = verification.registrationInfo;
    try { await db.collection('passkeys').insertOne({ _id: credential.id, userId: user._id, publicKey: Buffer.from(credential.publicKey), counter: credential.counter, transports: credential.transports || [], createdAt: new Date(now) }); }
    catch (error) { if (error.code === 11000) throw new HttpError(409, 'Esta passkey ya está registrada.'); throw error; }
    return { ok: true };
}
export async function authenticationOptions(db, env, now) {
    const { rpID } = config(env);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    return { options, challengeId: await saveChallenge(db, 'authentication', options.challenge, now) };
}
export async function authenticatePasskey(db, body, env, now) {
    const { origin, rpID } = config(env);
    const challenge = await consume(db, body?.challengeId, 'authentication', now);
    if (typeof body?.response?.id !== 'string' || body.response.id.length > 2048) throw new HttpError(400, 'Passkey inválida.');
    const passkey = await db.collection('passkeys').findOne({ _id: body.response.id });
    if (!passkey) throw new HttpError(401, 'No se pudo ingresar con esta passkey.');
    let verification;
    try { verification = await verifyAuthenticationResponse({ response: body.response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, credential: { id: passkey._id, publicKey: new Uint8Array(Buffer.isBuffer(passkey.publicKey) ? passkey.publicKey : passkey.publicKey.buffer), counter: passkey.counter, transports: passkey.transports }, requireUserVerification: true }); }
    catch { throw new HttpError(401, 'No se pudo verificar la passkey.'); }
    if (!verification.verified) throw new HttpError(401, 'No se pudo verificar la passkey.');
    const updated = await db.collection('passkeys').updateOne({ _id: passkey._id, counter: passkey.counter }, { $set: { counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date(now) } });
    if (!updated.matchedCount) throw new HttpError(401, 'Volvé a intentar el ingreso.');
    const user = await db.collection('users').findOne({ _id: passkey.userId, disabled: { $ne: true } });
    if (!user) throw new HttpError(401, 'No se pudo ingresar con esta passkey.');
    return user;
}
