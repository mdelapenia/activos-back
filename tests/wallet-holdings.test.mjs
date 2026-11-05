import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectWalletNetworks, previewWalletHoldings, walletAddresses, walletHoldings } from '../server/wallets.mjs';
import { address as bitcoinCodec } from 'bitcoinjs-lib';

test('consulta solo una wallet del usuario y normaliza moneda nativa y tokens', async () => {
    const user = { _id: 'user-a' };
    const wallet = { userId: user._id, id: 'wallet-id', network: 'base', address: '0x' + '1'.repeat(40) };
    const db = { collection: () => ({ findOne: async query => query.userId === wallet.userId && query.id === wallet.id ? wallet : null }) };
    const fetcher = async url => ({ ok: true, json: async () => url.endsWith('token-balances') ? [{ value: '1250000', token: { type: 'ERC-20', address_hash: '0x' + '2'.repeat(40), decimals: '6', symbol: 'USDC', name: 'USD Coin' } }, { value: '1', token: { type: 'ERC-721' } }] : { coin_balance: '1000000000000000000' } });
    const result = await walletHoldings(db, user, wallet.id, fetcher);
    assert.equal(result.holdings.length, 2);
    assert.equal(result.holdings[0].units, 1);
    assert.equal(result.holdings[1].units, 1.25);
    await assert.rejects(walletHoldings(db, { _id: 'user-b' }, wallet.id, fetcher), { status: 404 });
});

test('Solana conserva la dirección y combina cuentas del mismo token', async () => {
    const address = 'So11111111111111111111111111111111111111112';
    let inserted;
    const db = { collection: () => ({ insertOne: async doc => { inserted = doc; }, find: () => ({ toArray: async () => [inserted] }), findOne: async () => inserted }) };
    await walletAddresses(db, { _id: 'user' }, 'POST', { network: 'solana', address });
    assert.equal(inserted.address, address);
    assert.ok(inserted._id.endsWith(address));
    const fetcher = async (_url, options) => {
        const method = JSON.parse(options.body).method;
        const info = { mint: address, tokenAmount: { uiAmountString: '1.5' } };
        return { ok: true, json: async () => ({ result: { value: method === 'getBalance' ? 1000000000 : [{ account: { data: { parsed: { info } } } }] } }) };
    };
    const { holdings } = await walletHoldings(db, { _id: 'user' }, inserted.id, fetcher);
    assert.equal(holdings[0].coin, 'solana');
    assert.equal(holdings[1].units, 3);
    assert.equal(holdings[1].key, address);
});

test('las nuevas redes usan su explorador y moneda nativa', async () => {
    const cases = [['gnosis', 'gnosis.blockscout.com', 'XDAI'], ['celo', 'celo.blockscout.com', 'CELO'], ['zksync', 'zksync.blockscout.com', 'ETH'], ['scroll', 'scroll.blockscout.com', 'ETH'], ['linea', 'linea.blockscout.com', 'ETH']];
    for (const [network, host, symbol] of cases) {
        const db = { collection: () => ({ findOne: async () => ({ network, address: '0x' + '1'.repeat(40) }) }) };
        const fetcher = async url => { assert.equal(new URL(url).host, host); return { ok: true, json: async () => url.endsWith('token-balances') ? [] : { coin_balance: '1000000000000000000' } }; };
        const result = await walletHoldings(db, { _id: 'user' }, 'wallet', fetcher);
        assert.equal(result.holdings[0].symbol, symbol);
    }
});

test('Bitcoin valida direcciones mainnet y consulta el saldo confirmado en BTC', async () => {
    const saved = [];
    const db = { collection: () => ({ insertOne: async doc => { if (saved.some(row => row._id === doc._id)) throw Object.assign(new Error(), { code: 11000 }); saved.push(doc); }, find: () => ({ toArray: async () => saved }), findOne: async query => saved.find(row => row.userId === query.userId && row.id === query.id) }) };
    const user = { _id: 'user' };
    const legacy = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
    const segwit = bitcoinCodec.toBech32(Buffer.alloc(20, 1), 0, 'bc');
    const taproot = bitcoinCodec.toBech32(Buffer.alloc(32, 2), 1, 'bc');
    for (const address of [legacy, segwit, taproot]) await walletAddresses(db, user, 'POST', { network: 'bitcoin', address });
    assert.ok(saved[0]._id.endsWith(legacy));
    await assert.rejects(walletAddresses(db, user, 'POST', { network: 'bitcoin', address: segwit.toUpperCase() }), { status: 409 });
    for (const address of ['not-an-address', '1BoatSLRHtKNngkdXEeobR76b53LETtpyU', bitcoinCodec.toBech32(Buffer.alloc(20, 1), 0, 'tb')]) await assert.rejects(walletAddresses(db, user, 'POST', { network: 'bitcoin', address }), { status: 400 });
    const fetcher = async url => { assert.equal(url, `https://mempool.space/api/address/${legacy}`); return { ok: true, json: async () => ({ chain_stats: { funded_txo_sum: 250000000, spent_txo_sum: 50000000 }, mempool_stats: { funded_txo_sum: 100000000 } }) }; };
    assert.deepEqual(await walletHoldings(db, user, saved[0].id, fetcher), { holdings: [{ key: 'native', name: 'Bitcoin', symbol: 'BTC', units: 2, coin: 'bitcoin' }], truncated: false });
    await assert.rejects(walletHoldings(db, { _id: 'other' }, saved[0].id, fetcher), { status: 404 });
    await assert.rejects(walletHoldings(db, user, saved[0].id, async () => ({ ok: true, json: async () => ({ chain_stats: {} }) })), { status: 503 });
});

test('BNB consulta saldo nativo por RPC y avisa que no incluye tokens', async () => {
    const address = '0x' + '1'.repeat(40);
    const db = { collection: () => ({ findOne: async () => ({ network: 'bnb', address }) }) };
    let calls = 0;
    const fetcher = async (url, options) => {
        calls++;
        assert.match(url, /^https:\/\/bsc-dataseed/);
        assert.deepEqual(JSON.parse(options.body).params, [address, 'latest']);
        return calls === 1 ? { ok: false } : { ok: true, json: async () => ({ result: '0xde0b6b3a7640000' }) };
    };
    const result = await walletHoldings(db, { _id: 'user' }, 'wallet', fetcher);
    assert.equal(result.holdings[0].units, 1);
    assert.equal(result.holdings[0].coin, 'binancecoin');
    assert.match(result.notice, /tokens/);
    assert.equal(calls, 2);
    await assert.rejects(walletHoldings(db, { _id: 'user' }, 'wallet', async () => ({ ok: true, json: async () => ({ result: 'invalid' }) })), { status: 503 });
});

test('detecta Bitcoin y Solana y ofrece todas las redes posibles para direcciones EVM', () => {
    assert.deepEqual(detectWalletNetworks('1BoatSLRHtKNngkdXEeobR76b53LETtpyT').networks, ['bitcoin']);
    assert.deepEqual(detectWalletNetworks('So11111111111111111111111111111111111111112').networks, ['solana']);
    const evm = detectWalletNetworks('0x' + '1'.repeat(40)).networks;
    assert.ok(evm.includes('ethereum') && evm.includes('bnb') && evm.includes('base'));
    assert.deepEqual(detectWalletNetworks('no válida').networks, []);
});

test('consulta una dirección válida antes de guardarla y distingue saldo cero de error', async () => {
    const body = { network: 'bitcoin', address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' };
    const result = await previewWalletHoldings(body, async () => ({ ok: true, json: async () => ({ chain_stats: { funded_txo_sum: 10, spent_txo_sum: 10 } }) }));
    assert.deepEqual(result.holdings, []);
    await assert.rejects(previewWalletHoldings(body, async () => ({ ok: false })), { status: 503 });
    await assert.rejects(previewWalletHoldings({ ...body, network: 'bnb' }, async () => { throw new Error('No debería consultar'); }), { status: 400 });
});
