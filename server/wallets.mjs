import { randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';

const networks = ['ethereum', 'polygon', 'base', 'arbitrum', 'optimism', 'bnb'];

export async function walletAddresses(db, user, method, body) {
    const collection = db.collection('wallet_addresses');
    if (method === 'POST') {
        const address = typeof body?.address === 'string' ? body.address.trim() : '';
        const network = body?.network;
        if (!networks.includes(network) || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new HttpError(400, 'Ingresá una dirección pública válida para la red seleccionada.');
        const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 60) : '';
        const key = `${user._id}:${network}:${address.toLowerCase()}`;
        try { await collection.insertOne({ _id: key, id: randomUUID(), userId: user._id, network, address, label }); }
        catch (error) { if (error.code === 11000) throw new HttpError(409, 'Esta dirección ya está guardada para esa red.'); throw error; }
    }
    if (method === 'DELETE') {
        if (typeof body?.id !== 'string') throw new HttpError(400, 'Dirección inválida.');
        await collection.deleteOne({ userId: user._id, id: body.id });
    }
    const wallets = await collection.find({ userId: user._id }).toArray();
    return { wallets: wallets.map(({ id, address, network, label }) => ({ id, address, network, label })) };
}
