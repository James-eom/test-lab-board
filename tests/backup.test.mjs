import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
test('online backup reopens with preserved users, bookings and history', async () => {
  const folder = await mkdtemp(resolve(tmpdir(), 'lab-backup-check-'));
  const s = new Store(resolve(folder, 'source.sqlite'));
  try {
    const u = s.addUser('backupuser', '검증 계정', 'hash', 'admin');
    s.saveReservation({ equipmentId: 'endurance', testType: '단품 대상내구 시험', title: '복구 검증', ownerId: u.id, start: '2026-10-09T20:30:00+09:00', end: '2026-10-12T08:30:00+09:00', status: '계획' }, u.id);
    const output = execFileSync(process.execPath, ['scripts/backup.mjs'], { env: { ...process.env, DB_PATH: resolve(folder, 'source.sqlite'), BACKUP_DIR: resolve(folder, 'backups') }, encoding: 'utf8' });
    assert.match(output, /Backup verified/);
    const files = await readdir(resolve(folder, 'backups'));
    const restored = new Store(resolve(folder, 'backups', files[0]));
    assert.equal(restored.users()[0].name, '검증 계정');
    assert.equal(restored.reservations()[0].title, '복구 검증');
    assert.equal(restored.history(restored.reservations()[0].id).length, 1);
    restored.db.close();
  } finally { s.db.close(); await rm(folder, { recursive: true, force: true }); }
});
