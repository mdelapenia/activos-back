import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletAddresses, walletHoldings } from '../server/wallets.mjs';

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
