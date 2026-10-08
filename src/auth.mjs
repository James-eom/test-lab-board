import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { fail } from './store.mjs';
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) fail('비밀번호는 10~200자로 입력해 주세요.');
  const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password, hash) {
  if (typeof password !== 'string' || password.length > 200) return false;
  const [salt, value] = hash.split(':'); const check = scryptSync(password, salt, 64); const expected = Buffer.from(value, 'hex');
  return check.length === expected.length && timingSafeEqual(check, expected);
}
const tokenHash = t => createHash('sha256').update(t).digest('hex');
export function createSession(store, userId) {
  const token = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex');
  store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(tokenHash(token), userId, csrf, Date.now() + 12 * 3600000);
  return { token, csrf };
}
export function sessionFor(store, req) {
  const token = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  if (!token) return null;
  const session = store.db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(tokenHash(token), Date.now());
  if (!session) return null;
  const user = store.users().find(u => u.id === session.userId); return user ? { ...session, user } : null;
}
