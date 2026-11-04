import { createHash } from 'node:crypto';

// Los importes se conservan como texto decimal; nunca se convierten a Number.
export function decimal(value) {
    if (typeof value !== 'string' || !/^\d{1,40}(?:\.\d{1,30})?$/.test(value)) throw new TypeError('Decimal inválido');
    const [integer, fraction = ''] = value.split('.');
    return `${integer.replace(/^0+(?=\d)/, '')}${fraction.replace(/0+$/, '') ? `.${fraction.replace(/0+$/, '')}` : ''}`;
}

export function addDecimals(values) {
    if (!values.length) return '0';
    const normalized = values.map(decimal);
    const scale = Math.max(...normalized.map(value => (value.split('.')[1] || '').length));
    const total = normalized.reduce((sum, value) => {
        const [integer, fraction = ''] = value.split('.');
        return sum + BigInt(integer + fraction.padEnd(scale, '0'));
    }, 0n).toString().padStart(scale + 1, '0');
    return decimal(scale ? `${total.slice(0, -scale)}.${total.slice(-scale)}` : total);
}

// No se agrupan operaciones por ticker ni por fecha: cada ejecución debe tener
// una identidad de orden explícita, compartida por todas sus filas.
export function groupExecutions(executions) {
    const groups = new Map();
    for (const row of executions) {
        if (!row || typeof row.orderId !== 'string' || !row.orderId.trim() || typeof row.executionId !== 'string' || !row.executionId.trim()) throw new TypeError('La ejecución necesita ID de orden y de ejecución');
        const orderId = row.orderId.trim();
        const key = `${orderId}\0${row.executionId.trim()}`;
        if (groups.has(key)) throw new TypeError('ID de ejecución repetido');
        groups.set(key, { ...row, orderId, executionId: row.executionId.trim(), quantity: decimal(row.quantity), price: decimal(row.price), amount: decimal(row.amount), fee: decimal(row.fee ?? '0') });
    }
    const orders = new Map();
    for (const execution of groups.values()) {
        const rows = orders.get(execution.orderId) ?? [];
        rows.push(execution); orders.set(execution.orderId, rows);
    }
    return [...orders].map(([orderId, rows]) => ({ orderId, executions: rows, quantity: addDecimals(rows.map(row => row.quantity)), amount: addDecimals(rows.map(row => row.amount)), fee: addDecimals(rows.map(row => row.fee)) }));
}

// La coincidencia por campos es una señal para revisión, no prueba de identidad:
// dos órdenes legítimas pueden tener el mismo monto, activo y fecha.
export function operationFingerprint(operation) {
    const { asset, side, date, currency, quantity, amount } = operation;
    if (typeof asset !== 'string' || !asset.trim() || !['buy', 'sell'].includes(side) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !['USD', 'ARS'].includes(currency)) throw new TypeError('Operación incompleta');
    const input = JSON.stringify([asset.trim().toUpperCase(), side, date, currency, decimal(quantity), decimal(amount)]);
    return createHash('sha256').update(input).digest('hex');
}
