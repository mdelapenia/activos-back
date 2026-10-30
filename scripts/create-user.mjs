import { input, password } from '@inquirer/prompts';
import { closeDatabase, getDatabase } from '../server/database.mjs';
import { hashPin, normalizeEmail, validEmail, validPin } from '../server/security.mjs';
import { loadAtlasEnvironment } from '../server/environment.mjs';

try {
    loadAtlasEnvironment();
    const email = normalizeEmail(await input({ message: 'Correo de la cuenta:', validate: value => validEmail(normalizeEmail(value)) || 'Ingresá un correo válido.' }));
    const pin = await password({ message: 'PIN fijo (6 dígitos):', mask: '*', validate: value => validPin(value) || 'Usá exactamente 6 dígitos.' });
    await password({ message: 'Repetí el PIN:', mask: '*', validate: value => value === pin || 'Los PINs no coinciden.' });
    const db = await getDatabase();
    await db.collection('users').insertOne({ email, pinHash: await hashPin(pin), createdAt: new Date() });
    console.log('Cuenta creada. Ya podés ingresar con tu correo y PIN.');
} catch (error) {
    if (error.code === 11000) console.error('Ese correo ya tiene una cuenta. No se modificó su PIN.');
    else if (error.name === 'ExitPromptError') console.error('Creación cancelada.');
    else console.error('No se pudo crear la cuenta. Revisá la conexión y los permisos de MongoDB.');
    process.exitCode = 1;
} finally {
    await closeDatabase();
}
