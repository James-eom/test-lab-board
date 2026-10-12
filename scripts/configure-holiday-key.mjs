// Read from stdin so the credential is never a command-line argument.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { HolidaySync } from '../src/holiday-sync.mjs';
let key = '';
try {
  for await (const chunk of process.stdin) { key += chunk; if (key.length > 1024) throw new Error('Invalid key'); }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const store = new Store(process.env.DB_PATH || resolve(root, 'data/lab.sqlite'));
  try {
    store.saveHolidayApiKey(key); key = '';
    const year = Number(new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 4));
    const status = await new HolidaySync(store).refresh([year, year + 1], { force: true });
    console.log(JSON.stringify(status));
  } finally { store.db.close(); }
} catch { console.error('인증키 설정 또는 공휴일 조회를 완료하지 못했습니다.'); process.exitCode = 1; }
