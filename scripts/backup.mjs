import { DatabaseSync } from 'node:sqlite';
import { verifiedBackup } from '../src/backup.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(process.env.DB_PATH || resolve(root, 'data/lab.sqlite'), { readOnly: true });
try { console.log(`Backup verified: ${await verifiedBackup(db, process.env.BACKUP_DIR || resolve(root, 'data/backups'))}`); }
finally { db.close(); }
