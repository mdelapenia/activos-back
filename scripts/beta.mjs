import { closeDatabase, getDatabase } from '../server/database.mjs';
import { loadAtlasEnvironment } from '../server/environment.mjs';

loadAtlasEnvironment();
const kind = process.argv[2] || 'feedback';
if (!['feedback', 'inscripciones'].includes(kind)) {
    console.error('Uso: node scripts/beta.mjs [feedback|inscripciones]');
    process.exitCode = 1;
} else {
    try {
        const db = await getDatabase();
        const collection = kind === 'feedback' ? 'beta_feedback' : 'beta_signups';
        const rows = await db.collection(collection).find({}).sort({ [kind === 'feedback' ? 'createdAt' : 'updatedAt']: -1 }).toArray();
        console.log(JSON.stringify(rows, null, 2));
    } finally { await closeDatabase(); }
}
