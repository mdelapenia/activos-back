import { randomUUID } from 'node:crypto';
import { address as bitcoinAddressCodec, networks } from 'bitcoinjs-lib';
import { HttpError } from './security.mjs';

const explorers = { ethereum: ['eth.blockscout.com', 'ethereum', 'ETH'], polygon: ['polygon.blockscout.com', 'matic-network', 'POL'], base: ['base.blockscout.com', 'ethereum', 'ETH'], arbitrum: ['arbitrum.blockscout.com', 'ethereum', 'ETH'], optimism: ['optimism.blockscout.com', 'ethereum', 'ETH'], bnb: ['bsc.blockscout.com', 'binancecoin', 'BNB'], gnosis: ['gnosis.blockscout.com', 'xdai', 'XDAI'], celo: ['celo.blockscout.com', 'celo', 'CELO'], zksync: ['zksync.blockscout.com', 'ethereum', 'ETH'], scroll: ['scroll.blockscout.com', 'ethereum', 'ETH'], linea: ['linea.blockscout.com', 'ethereum', 'ETH'] };
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bitcoinAddress(address) {
    try {
        if (/^bc1/i.test(address)) {
            const decoded = bitcoinAddressCodec.fromBech32(address);
            return decoded.prefix === 'bc' && (decoded.version === 0 ? [20, 32].includes(decoded.data.length) : decoded.version === 1 && decoded.data.length === 32);
        }
        bitcoinAddressCodec.toOutputScript(address, networks.bitcoin);
        return true;
    } catch { return false; }
}

async function bitcoinHoldings(address, fetcher) {
    let response, data;
    try {
        response = await fetcher(`https://mempool.space/api/address/${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(15000) });
        if (response.ok) data = await response.json();
    } catch { /* report provider failure below */ }
    if (!response?.ok) throw new HttpError(503, 'No se pudo consultar Bitcoin. Intentá nuevamente.');
    const funded = data?.chain_stats?.funded_txo_sum, spent = data?.chain_stats?.spent_txo_sum;
    if (!Number.isSafeInteger(funded) || !Number.isSafeInteger(spent) || funded < 0 || spent < 0 || spent > funded) throw new HttpError(503, 'Bitcoin devolvió datos incompletos.');
    const units = (funded - spent) / 1e8;
    return { holdings: units > 0 ? [{ key: 'native', name: 'Bitcoin', symbol: 'BTC', units, coin: 'bitcoin' }] : [], truncated: false };
}

async function bnbHoldings(address, fetcher) {
    for (const endpoint of ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed-public.bnbchain.org']) {
        try {
            const response = await fetcher(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }), signal: AbortSignal.timeout(8000) });
            if (!response.ok) continue;
            const data = await response.json();
            if (data.error || typeof data.result !== 'string' || !/^0x[0-9a-f]+$/i.test(data.result)) continue;
            const units = Number(BigInt(data.result)) / 1e18;
            if (!Number.isFinite(units)) continue;
            return { holdings: units > 0 ? [{ key: 'native', name: 'BNB', symbol: 'BNB', units, coin: 'binancecoin' }] : [], truncated: false, notice: 'Solo se consultó BNB nativo. Los demás tokens de BNB Smart Chain no están incluidos.' };
        } catch { /* try the next public endpoint */ }
    }
    throw new HttpError(503, 'No se pudo consultar BNB Smart Chain. Intentá nuevamente.');
}
function solanaAddress(address) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
    let value = 0n;
    for (const char of address) value = value * 58n + BigInt(alphabet.indexOf(char));
    let bytes = 0; while (value > 0n) { bytes++; value >>= 8n; }
    return bytes + (address.match(/^1*/)?.[0].length ?? 0) === 32;
}

export function detectWalletNetworks(value) {
    const address = typeof value === 'string' ? value.trim() : '';
    if (address.length > 90) return { networks: [] };
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) return { networks: Object.keys(explorers) };
    return { networks: [...(bitcoinAddress(address) ? ['bitcoin'] : []), ...(solanaAddress(address) ? ['solana'] : [])] };
}

async function solanaHoldings(address, fetcher) {
    async function rpc(method, params) {
        let response, data;
        try { response = await fetcher('https://api.mainnet.solana.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) }); if (response.ok) data = await response.json(); }
        catch { /* report provider failure below */ }
        if (!response?.ok || data?.error || !data?.result) throw new HttpError(503, 'No se pudo consultar Solana. Intentá nuevamente.');
        return data.result.value;
    }
    const programs = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
    const [balance, ...accounts] = await Promise.all([rpc('getBalance', [address]), ...programs.map(programId => rpc('getTokenAccountsByOwner', [address, { programId }, { encoding: 'jsonParsed' }]))]);
    if (!Number.isSafeInteger(balance) || balance < 0 || accounts.some(rows => !Array.isArray(rows))) throw new HttpError(503, 'Solana devolvió datos incompletos.');
    const holdings = balance ? [{ key: 'native', name: 'Solana', symbol: 'SOL', units: balance / 1e9, coin: 'solana' }] : [];
    const tokens = new Map();
    for (const row of accounts.flat()) {
        const info = row?.account?.data?.parsed?.info, mint = info?.mint, units = Number(info?.tokenAmount?.uiAmountString);
        if (!solanaAddress(mint || '') || !Number.isFinite(units) || units <= 0) continue;
        tokens.set(mint, (tokens.get(mint) || 0) + units);
    }
    for (const [mint, units] of [...tokens].slice(0, 500)) holdings.push({ key: mint, name: `Token ${mint.slice(0, 8)}…`, symbol: '', units, coin: '' });
    return { holdings, truncated: tokens.size > 500 };
}

export async function walletHoldings(db, user, id, fetcher = fetch) {
    const wallet = typeof id === 'string' && await db.collection('wallet_addresses').findOne({ userId: user._id, id });
    return holdingsForWallet(wallet, fetcher);
}

export async function previewWalletHoldings(body, fetcher = fetch) {
    const address = typeof body?.address === 'string' ? body.address.trim() : '';
    if (!detectWalletNetworks(address).networks.includes(body?.network)) throw new HttpError(400, 'Ingresá una dirección pública válida para la red seleccionada.');
    return holdingsForWallet({ address, network: body.network }, fetcher);
}

async function holdingsForWallet(wallet, fetcher) {
    if (!wallet || (wallet.network !== 'solana' && wallet.network !== 'bitcoin' && !Object.hasOwn(explorers, wallet.network))) throw new HttpError(404, 'No se encontró la wallet.');
    if (wallet.network === 'bitcoin') return bitcoinHoldings(wallet.address, fetcher);
    if (wallet.network === 'bnb') return bnbHoldings(wallet.address, fetcher);
    if (wallet.network === 'solana') return solanaHoldings(wallet.address, fetcher);
    const [host, coin, symbol] = explorers[wallet.network];
    const base = `https://${host}/api/v2/addresses/${wallet.address}`;
    async function get(url) {
        let response;
        try { response = await fetcher(url, { signal: AbortSignal.timeout(15000) }); } catch { throw new HttpError(503, 'No se pudo consultar la red. Intentá nuevamente.'); }
        if (!response.ok) throw new HttpError(503, 'El explorador de esta red no está disponible. Intentá nuevamente.');
        try { return await response.json(); } catch { throw new HttpError(503, 'El explorador devolvió datos inválidos.'); }
    }
    const [account, tokens] = await Promise.all([get(base), get(`${base}/token-balances`)]);
    if (!Array.isArray(tokens) || typeof account?.coin_balance !== 'string' || !/^\d+$/.test(account.coin_balance)) throw new HttpError(503, 'El explorador devolvió datos incompletos.');
    const native = Number(account.coin_balance) / 1e18;
    const holdings = native > 0 && Number.isFinite(native) ? [{ key: 'native', name: symbol, symbol, units: native, coin }] : [];
    for (const row of tokens.slice(0, 500)) {
        const token = row?.token, decimals = Number(token?.decimals);
        if (token?.type !== 'ERC-20' || !/^0x[0-9a-fA-F]{40}$/.test(token?.address_hash || '') || !/^\d+$/.test(row?.value || '') || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
        const units = Number(row.value) / 10 ** decimals;
        if (!Number.isFinite(units) || units <= 0) continue;
        holdings.push({ key: token.address_hash.toLowerCase(), name: String(token.name || token.symbol || 'Token').slice(0, 70), symbol: String(token.symbol || '').slice(0, 30), units, coin: '' });
    }
    return { holdings, truncated: tokens.length > 500 };
}

export async function walletAddresses(db, user, method, body) {
    const collection = db.collection('wallet_addresses');
    if (method === 'POST') {
        const address = typeof body?.address === 'string' ? body.address.trim() : '';
        const network = body?.network;
        const valid = network === 'solana' ? solanaAddress(address) : network === 'bitcoin' ? bitcoinAddress(address) : typeof network === 'string' && Object.hasOwn(explorers, network) && /^0x[0-9a-fA-F]{40}$/.test(address);
        if (!valid) throw new HttpError(400, 'Ingresá una dirección pública válida para la red seleccionada.');
        const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 60) : '';
        const keyAddress = network === 'solana' || (network === 'bitcoin' && !/^bc1/i.test(address)) ? address : address.toLowerCase();
        const key = `${user._id}:${network}:${keyAddress}`;
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
