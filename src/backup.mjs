import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function verifiedBackup(db, folder) {
  await mkdir(folder, { recursive: true });
  const target = resolve(folder, `lab-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`);
  await backup(db, target);
  const check = new DatabaseSync(target);
  try {
    check.exec('PRAGMA journal_mode=DELETE');
    if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('백업 무결성 검사 실패');
  } finally { check.close(); }
  return target;
}
