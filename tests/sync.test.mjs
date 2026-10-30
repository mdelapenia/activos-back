import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortfolioSync } from '../../front/src/portfolio-sync.ts';
import { readLegacyPortfolio, cleanInvestment } from '../../front/src/portfolio.ts';
import { emptyPortfolio } from '../server/portfolio.mjs';

const snapshot = () => ({ portfolio: emptyPortfolio(), version: 0, mutationId: null });
const acknowledge = mutation => ({ version: mutation.version + 1, mutationId: mutation.mutationId });
const edit = theme => current => ({ ...current, preferences: { ...current.preferences, theme } });

test('no guarda la cartera vacía al hidratar y serializa cambios mientras espera respuesta', async () => {
    const calls = [];
    let release;
    const sync = new PortfolioSync(snapshot(), async mutation => {
        calls.push(mutation);
        if (calls.length === 1) await new Promise(resolve => { release = resolve; });
        return acknowledge(mutation);
    });
    await sync.flush();
    assert.equal(calls.length, 0);
    sync.update(edit('light'));
    const first = sync.flush();
    sync.update(edit('dark'));
    const second = sync.flush();
    assert.equal(first, second);
    release();
    assert.equal(await first, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].version, 1);
    assert.equal(calls[1].portfolio.preferences.theme, 'dark');
    assert.equal(sync.getSnapshot().dirty, false);
});

test('una respuesta perdida se reintenta con el mismo ID, conservando cambios posteriores', async () => {
    const calls = [];
    const sync = new PortfolioSync(snapshot(), async mutation => {
        calls.push(mutation);
        if (calls.length === 1) throw new Error('Conexión interrumpida');
        return acknowledge(mutation);
    });
    sync.update(edit('light'));
    assert.equal(await sync.flush(), false);
    assert.equal(sync.getSnapshot().dirty, true);
    sync.update(edit('dark'));
    assert.equal(await sync.flush(), true);
    assert.equal(calls[0].mutationId, calls[1].mutationId);
    assert.notEqual(calls[1].mutationId, calls[2].mutationId);
    assert.equal(calls[2].portfolio.preferences.theme, 'dark');
});

test('conflicto y sesión vencida conservan cambios pendientes', async () => {
    for (const [status, expected] of [[409, 'conflict'], [401, 'expired']]) {
        const sync = new PortfolioSync(snapshot(), async () => { throw Object.assign(new Error('No guardado'), { status }); });
        sync.update(edit('light'));
        assert.equal(await sync.flush(), false);
        assert.equal(sync.getSnapshot().status, expected);
        assert.equal(sync.getSnapshot().portfolio.preferences.theme, 'light');
        assert.equal(sync.getSnapshot().dirty, true);
        sync.reset(snapshot());
        assert.equal(sync.getSnapshot().dirty, false);
    }
});

test('migra el respaldo local sin borrarlo ni aceptar datos corruptos', () => {
    const valid = { id: 'bitcoin', name: 'Bitcoin', amount: 100, currency: 'USD', date: '2026-01-01', kind: 'crypto', coin: 'bitcoin', units: 0.01 };
    const storage = { getItem: key => key === 'inversiones:v2' ? JSON.stringify([valid, valid, null, { bad: true }]) : key === 'inversiones:theme' ? 'light' : null };
    const loaded = readLegacyPortfolio(storage);
    assert.deepEqual(loaded.investments, [valid]);
    assert.equal(loaded.preferences.theme, 'light');
    assert.equal(cleanInvestment({ ...valid, date: '2026-02-31' }), null);
    assert.equal(readLegacyPortfolio({ getItem() { throw new Error('Storage bloqueado'); } }).investments.length, 0);
});
