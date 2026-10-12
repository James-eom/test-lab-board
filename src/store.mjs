import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { EQUIPMENT, DEFAULT_RULES, expandReservation, activeIntervals, validateInterval, supportsWeekend, canRunTogether } from './schedule.mjs';
import { NATIONAL_HOLIDAYS, HOLIDAY_YEARS } from './holidays.mjs';

export function fail(message, status = 400, code) { throw Object.assign(new Error(message), { status, code }); }
const now = () => new Date().toISOString();
const parse = row => row && JSON.parse(row.payload);
const text = (v, limit = 1000) => typeof v === 'string' && v.length <= limit ? v.trim() : fail('입력한 문자열을 확인해 주세요.');
export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intervals(reservationId TEXT NOT NULL REFERENCES reservations(id), equipmentId TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS interval_lookup ON intervals(equipmentId,start,end);
      CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY, reservationId TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actuals(reservationId TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS baselines(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS downtimes(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automatic_plans(id TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  users() { return this.db.prepare('SELECT id,login,name,role FROM users ORDER BY name').all(); }
  addUser(login, name, hash, role = 'member') {
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(login)) fail('아이디는 영문·숫자 3~40자로 입력해 주세요.');
    if (!['admin', 'member'].includes(role)) fail('권한을 확인해 주세요.');
    const user = { id: randomUUID(), login, name: text(name, 40), role };
    if (!user.name) fail('이름을 입력해 주세요.');
    try { this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user.id, login, user.name, hash, role); }
    catch (e) { if (e.message.includes('UNIQUE')) fail('이미 등록된 아이디입니다.', 409); throw e; }
    return user;
  }
  customHolidays() { return parse(this.db.prepare("SELECT payload FROM settings WHERE key='holidays'").get()) || []; }
  holidayApiKey() { return parse(this.db.prepare("SELECT payload FROM settings WHERE key='holiday-api-key'").get()) || ''; }
  saveHolidayApiKey(key) {
    if (typeof key !== 'string' || key.trim().length < 20 || key.trim().length > 512 || /\s/.test(key.trim())) fail('인증키 형식을 확인해 주세요.');
    try { key = decodeURIComponent(key.trim()); } catch { fail('인증키 인코딩을 확인해 주세요.'); }
    if (/\s/.test(key) || key.length < 20) fail('인증키 형식을 확인해 주세요.');
    this.db.prepare("INSERT INTO settings VALUES('holiday-api-key',?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(key));
  }
  holidayCache() { return parse(this.db.prepare("SELECT payload FROM settings WHERE key='holiday-cache'").get()) || {}; }
  saveHolidayYear(year, holidays) {
    const cache = this.holidayCache(); cache[year] = { holidays, updatedAt: now() };
    this.db.prepare("INSERT INTO settings VALUES('holiday-cache',?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(cache));
  }
  holidayYears() { return [...new Set([...HOLIDAY_YEARS, ...Object.keys(this.holidayCache()).map(Number)])].sort((a, b) => a - b); }
  rules() {
    const cache = this.holidayCache(), holidays = new Map();
    for (const h of [...this.customHolidays(), ...NATIONAL_HOLIDAYS.filter(h => !cache[h.date.slice(0, 4)]), ...Object.values(cache).flatMap(c => c.holidays)]) holidays.set(h.date, h);
    return { ...(parse(this.db.prepare("SELECT payload FROM settings WHERE key='rules'").get()) || DEFAULT_RULES), holidays: [...holidays.values()] };
  }
  saveHoliday(input) {
    const date = input.date, name = text(input.name, 80);
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || !name) fail('공휴일 날짜와 이름을 확인해 주세요.');
    if (this.rules().holidays.some(h => h.date === date)) fail('이미 등록된 공휴일입니다.', 409);
    const holiday = { date, name, source: 'custom' };
    this.db.prepare("INSERT INTO settings VALUES('holidays',?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload").run(JSON.stringify([...this.customHolidays(), holiday]));
    return holiday;
  }
  removeHoliday(date) {
    if (!this.customHolidays().some(h => h.date === date)) fail('추가 등록한 공휴일만 삭제할 수 있습니다.', 404);
    this.db.prepare("UPDATE settings SET payload=? WHERE key='holidays'").run(JSON.stringify(this.customHolidays().filter(h => h.date !== date)));
  }
  reservations() { return this.db.prepare('SELECT payload FROM reservations').all().map(parse).sort((a, b) => a.start.localeCompare(b.start)); }
  reservation(id) { return parse(this.db.prepare('SELECT payload FROM reservations WHERE id=?').get(id)); }
  saveReservation(input, userId, id) {
    return this.transaction(() => this.writeReservation(input, userId, id));
  }
  writeReservation(input, userId, id) {
      const old = id ? this.reservation(id) : null;
      if (id && !old) fail('예약을 찾을 수 없습니다.', 404);
      if (old && input.version !== old.version) fail('다른 팀원이 변경했습니다. 최신 내용을 다시 확인해 주세요.', 409);
      if (old && !text(input.reason || '', 500)) fail('변경 사유를 입력해 주세요.');
      const e = EQUIPMENT.find(e => e.id === input.equipmentId);
      const unchangedLegacyType = old && old.equipmentId === input.equipmentId && old.testType === input.testType;
      if (!e || (!e.types.includes(input.testType) && !unchangedLegacyType)) fail('설비와 시험 종류를 확인해 주세요.');
      if (input.includeWeekend !== undefined && typeof input.includeWeekend !== 'boolean') fail('주말 포함 여부를 확인해 주세요.');
      if (input.includeWeekend === true && !supportsWeekend(e.id)) fail('이 설비에는 주말 포함 옵션을 적용할 수 없습니다.');
      if (!this.users().some(u => u.id === input.ownerId)) fail('담당자를 선택해 주세요.');
      if (!['계획', '진행', '완료', '취소'].includes(input.status)) fail('상태를 확인해 주세요.');
      const r = { id: id || randomUUID(), equipmentId: e.id, testType: input.testType, title: text(input.title, 160), project: text(input.project || '', 100), ownerId: input.ownerId,
        start: new Date(input.start).toISOString(), end: new Date(input.end).toISOString(), includeWeekend: input.includeWeekend === true, status: input.status, note: text(input.note || '', 2000), version: (old?.version || 0) + 1, createdAt: old?.createdAt || now(), updatedAt: now(), ...(old?.automaticPlan ? { automaticPlan: old.automaticPlan } : {}) };
      if (!r.title) fail('시험명을 입력해 주세요.');
      const unchangedPeriod = old && old.equipmentId === r.equipmentId && old.testType === r.testType && old.start === r.start && old.end === r.end && (old.includeWeekend === true) === r.includeWeekend;
      let intervals;
      try { intervals = expandReservation(r, this.rules(), { validateOperatingDays: !unchangedPeriod }); }
      catch (e) { fail(e.message); }
      if (old && this.db.prepare('SELECT 1 FROM actuals WHERE reservationId=?').get(id) && (r.start !== old.start || r.end !== old.end || r.equipmentId !== old.equipmentId || r.testType !== old.testType || r.includeWeekend !== (old.includeWeekend === true) || r.status === '취소')) fail('실적이 등록된 시험은 기간·설비·종류·주말 포함 변경이나 취소 전에 실적을 확인해 주세요.', 409);
      if (r.status !== '취소') for (const i of intervals) {
        // Recompute with current holidays so additions/removals cannot leave stale conflicts.
        const overlaps = this.reservations().filter(other => other.id !== r.id && other.equipmentId === r.equipmentId && other.status !== '취소' && expandReservation(other, this.rules(), { validateOperatingDays: false }).some(part => part.start < i.end && part.end > i.start));
        if (overlaps.some(other => !canRunTogether(r, other))) fail('같은 설비에 중복 예약이 있습니다.', 409, 'DUPLICATE_BOOKING');
        if (this.downtimes().some(d => d.equipmentId === r.equipmentId && d.start < i.end && d.end > i.start)) fail('설비 정지 일정과 겹칩니다.', 409);
      }
      this.db.prepare('INSERT INTO reservations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(r.id, JSON.stringify(r));
      this.db.prepare('DELETE FROM intervals WHERE reservationId=?').run(r.id);
      if (r.status !== '취소') for (const i of intervals) this.db.prepare('INSERT INTO intervals VALUES(?,?,?,?)').run(r.id, r.equipmentId, i.start, i.end);
      this.db.prepare('INSERT INTO history(reservationId,payload) VALUES(?,?)').run(r.id, JSON.stringify({ before: old, after: r, ...(!old ? { plannedIntervals: activeIntervals(r, this.rules()) } : {}), reason: text(input.reason || '최초 등록', 500), userId, at: now() }));
      return r;
  }
  scheduleDeletionPreview() {
    const tables = ['intervals', 'actuals', 'history', 'baselines', 'automatic_plans', 'reservations'];
    const snapshot = Object.fromEntries(tables.map(table => [table, this.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    return { counts: Object.fromEntries(tables.map(table => [table, snapshot[table].length])), revision: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
  }
  deleteAllSchedules(revision) {
    return this.transaction(() => {
      const preview = this.scheduleDeletionPreview();
      if (revision !== preview.revision) fail('시험 데이터가 변경되었습니다. 삭제 대상을 다시 확인해 주세요.', 409, 'STALE_DELETION');
      for (const table of Object.keys(preview.counts)) this.db.exec(`DELETE FROM ${table}`);
      return preview.counts;
    });
  }
  history(id) { return this.db.prepare('SELECT payload FROM history WHERE reservationId=? ORDER BY seq').all(id).map(parse); }
  originalPlans() {
    return this.db.prepare('SELECT payload FROM history WHERE seq IN (SELECT MIN(seq) FROM history GROUP BY reservationId)').all().map(row => {
      const h = parse(row);
      // Older records predate interval snapshots and use the original default rules.
      try { return { ...h.after, plannedIntervals: h.plannedIntervals ?? activeIntervals(h.after, DEFAULT_RULES) }; }
      catch { return { ...h.after, plannedIntervals: null }; }
    });
  }
  actuals() { return this.db.prepare('SELECT payload FROM actuals').all().map(parse); }
  removeActual(id) {
    if (!this.db.prepare('DELETE FROM actuals WHERE reservationId=?').run(id).changes) fail('삭제할 실적이 없습니다. 최신 내용을 확인해 주세요.', 404);
  }
  saveActual(input, userId) {
    const r = this.reservation(input.reservationId);
    if (!r || r.status === '취소') fail('유효한 예약을 선택해 주세요.');
    const actual = { reservationId: r.id, zero: input.zero === true, note: text(input.note || '', 1000), userId, at: now() };
    if (!actual.zero) {
      validateInterval(input.start, input.end);
      actual.start = new Date(input.start).toISOString(); actual.end = new Date(input.end).toISOString();
      if (actual.start < r.start || actual.end > r.end) fail('실적 기간은 예약 기간 안으로 입력해 주세요.');
      // Actual activity is evidence, even when a holiday is registered later.
      expandReservation({ ...r, ...actual }, { ...this.rules(), holidays: [] });
    } else if (!actual.note) fail('0시간 실적의 사유를 입력해 주세요.');
    this.db.prepare('INSERT INTO actuals VALUES(?,?) ON CONFLICT(reservationId) DO UPDATE SET payload=excluded.payload').run(r.id, JSON.stringify(actual));
    return actual;
  }
  saveBaseline(month, userId) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('월을 확인해 주세요.');
    const a = new Date(`${month}-01T00:00:00+09:00`), next = new Date(`${month}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
    const b = new Date(next.toISOString().slice(0, 10) + 'T00:00:00+09:00');
    const baseline = { id: randomUUID(), month, userId, at: now(), reservations: this.reservations().filter(r => r.start < b.toISOString() && r.end > a.toISOString()) };
    this.db.prepare('INSERT INTO baselines VALUES(?,?)').run(baseline.id, JSON.stringify(baseline)); return baseline;
  }
  baselines() { return this.db.prepare('SELECT payload FROM baselines').all().map(parse); }
  downtimes() { return this.db.prepare('SELECT payload FROM downtimes').all().map(parse); }
  saveDowntime(input, userId) {
    validateInterval(input.start, input.end);
    if (!EQUIPMENT.some(e => e.id === input.equipmentId)) fail('설비를 확인해 주세요.');
    const d = { id: randomUUID(), equipmentId: input.equipmentId, start: new Date(input.start).toISOString(), end: new Date(input.end).toISOString(), reason: text(input.reason, 500), userId, at: now() };
    if (!d.reason) fail('정지 사유를 입력해 주세요.');
    this.db.prepare('INSERT INTO downtimes VALUES(?,?)').run(d.id, JSON.stringify(d)); return d;
  }
  removeDowntime(id) { this.db.prepare('DELETE FROM downtimes WHERE id=?').run(id); }
  saveRules(input) {
    const r = { days: input.days, open: input.open, close: input.close, breaks: input.breaks };
    if (!Array.isArray(r.days) || !r.days.length || r.days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || !Number.isInteger(r.open) || !Number.isInteger(r.close) || r.open < 0 || r.close > 1440 || r.open >= r.close || r.open % 30 || r.close % 30 || !Array.isArray(r.breaks) || r.breaks.length > 5 || r.breaks.some(i => !Array.isArray(i) || i.length !== 2 || i.some(v => !Number.isInteger(v) || v % 30) || i[0] < r.open || i[1] > r.close || i[0] >= i[1])) fail('운영일·시간·휴식을 확인해 주세요.');
    for (const booking of this.reservations().filter(b => b.status !== '취소')) { try { expandReservation(booking, { ...r, holidays: this.rules().holidays }, { validateOperatingDays: false }); } catch { fail('기존 예약이 새 운영시간 밖에 있습니다. 해당 예약을 먼저 조정해 주세요.', 409); } }
    this.db.prepare("INSERT INTO settings VALUES('rules',?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(r)); return r;
  }
}
