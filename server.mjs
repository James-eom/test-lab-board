import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, extname, basename } from 'node:path';
import { verifiedBackup } from './src/backup.mjs';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { Store, fail } from './src/store.mjs';
import { EQUIPMENT, capacity, validateInterval, expandReservation, activeIntervals, operatingMinutes, merge } from './src/schedule.mjs';
import { actualReservation } from './src/consecutive-windows.mjs';
import { hashPassword, checkPassword, createSession, sessionFor } from './src/auth.mjs';
import { HolidaySync } from './src/holiday-sync.mjs';
import { MonthlyPlanService } from './src/monthly-plan-service.mjs';
const ROOT = dirname(fileURLToPath(import.meta.url));
function reportYears(start, end) {
  let span;
  try { span = validateInterval(start, end, { maxDays: 3660 }); } catch (e) { fail(e.message); }
  const [a, b] = span;
  const first = new Date(a + 9 * 3600000).getUTCFullYear(), last = new Date(b - 1 + 9 * 3600000).getUTCFullYear();
  if (first < 2000 || last > 2100) fail('조회 연도는 2000~2100년으로 입력해 주세요.');
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
async function body(req) {
  let value = ''; for await (const chunk of req) { value += chunk; if (Buffer.byteLength(value) > 65536) fail('요청이 너무 큽니다.', 413); }
  try { const data = JSON.parse(value || '{}'); if (!data || Array.isArray(data) || typeof data !== 'object') fail('요청 형식을 확인해 주세요.'); return data; } catch { fail('요청 형식을 확인해 주세요.'); }
}
export function createApp({ dbPath = resolve(ROOT, 'data/lab.sqlite'), holidayFetch = fetch, backupDir = resolve(dirname(dbPath), 'backups'), backupDb = verifiedBackup, clock = () => Date.now() } = {}) {
  const store = new Store(dbPath), attempts = new Map();
  const holidaySync = new HolidaySync(store, holidayFetch);
  const monthlyPlans = new MonthlyPlanService(store,holidaySync,{clock});
  const currentYears = () => { const year = Number(new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 4)); return [year, year + 1]; };
  const server = http.createServer(async (req, res) => {
    const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    const cookie = token => res.setHeader('set-cookie', `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 43200 : 0}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'same-origin'); res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET') fail('허용되지 않은 요청입니다.', 405);
        let file;
        if (path === '/vendor/lucide.js') file = resolve(ROOT, 'node_modules/lucide/dist/umd/lucide.js');
        else { file = resolve(ROOT, 'public', '.' + decodeURIComponent(path === '/' ? '/index.html' : path)); if (!file.startsWith(resolve(ROOT, 'public') + '\\') && !file.startsWith(resolve(ROOT, 'public') + '/')) fail('파일을 찾을 수 없습니다.', 404); }
        const data = await readFile(file).catch(() => fail('파일을 찾을 수 없습니다.', 404));
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }); return res.end(data);
      }
      if (req.method !== 'GET' && req.headers.origin) { let origin; try { origin = new URL(req.headers.origin); } catch { fail('허용되지 않은 출처입니다.', 403); } if (origin.host !== req.headers.host) fail('허용되지 않은 출처입니다.', 403); }
      if (path === '/api/status' && req.method === 'GET') return json({ setupRequired: store.users().length === 0 });
      if (path === '/api/setup' && req.method === 'POST') {
        if (store.users().length) fail('관리자가 이미 등록돼 있습니다.', 409);
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) fail('첫 관리자 등록은 운영 PC에서 진행해 주세요.', 403);
        const data = await body(req);
        if (store.users().length) fail('관리자가 이미 등록돼 있습니다.', 409);
        const user = store.addUser(data.login, data.name, hashPassword(data.password), 'admin'); const session = createSession(store, user.id); cookie(session.token); return json({ user, csrf: session.csrf }, 201);
      }
      if (path === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress, count = attempts.get(ip) || { n: 0, until: Date.now() + 600000 };
        if (count.until < Date.now()) { count.n = 0; count.until = Date.now() + 600000; }
        if (count.n >= 10) fail('잠시 후 다시 로그인해 주세요.', 429);
        const data = await body(req), u = typeof data.login === 'string' ? store.db.prepare('SELECT * FROM users WHERE login=?').get(data.login) : null;
        if (!u || !u.active || !checkPassword(data.password, u.hash)) { count.n++; attempts.set(ip, count); fail('아이디 또는 비밀번호를 확인해 주세요.', 401); }
        attempts.delete(ip); const session = createSession(store, u.id); cookie(session.token); return json({ user: store.users().find(x => x.id === u.id), csrf: session.csrf });
      }
      const authenticated = () => {
        const current = sessionFor(store, req);
        if (!current) fail('로그인이 필요합니다.', 401);
        if (req.method !== 'GET' && req.headers['x-csrf-token'] !== current.csrf) fail('요청을 확인할 수 없습니다. 다시 로그인해 주세요.', 403);
        return current;
      };
      const session = authenticated();
      const admin = () => { if (authenticated().user.role !== 'admin') fail('관리자 권한이 필요합니다.', 403); };
      if (path === '/api/me' && req.method === 'GET') return json({ user: session.user, csrf: session.csrf });
      if(path==='/api/test-time-standards'&&req.method==='GET')return json(store.testTimeStandards());
      if(path==='/api/test-time-standards'&&req.method==='PUT'){admin();const input=await body(req);admin();return json(store.saveTestTimeStandards(input));}
      if(path==='/api/monthly-schedules/preview'&&req.method==='POST'){
        const input=await body(req),actor=authenticated().user;
        const result=await monthlyPlans.preview(actor.id,input);authenticated();return json(result);
      }
      if(path==='/api/monthly-schedules/confirm'&&req.method==='POST'){
        const input=await body(req),actor=authenticated().user;
        if(Object.keys(input).length!==1||typeof input.previewId!=='string'||!input.previewId||input.previewId.length>80)fail('편성안 식별자만 보내 주세요.');
        return json(await monthlyPlans.confirm(actor.id,input.previewId));
      }
      if (path === '/api/schedules/deletion-preview' && req.method === 'GET') { admin(); return json(store.scheduleDeletionPreview()); }
      if (path === '/api/schedules' && req.method === 'DELETE') {
        admin(); const input = await body(req); admin();
        if (input.confirmation !== '전체 시험 일정 삭제') fail('확인 문구를 정확히 입력해 주세요.');
        if (input.revision !== store.scheduleDeletionPreview().revision) fail('시험 데이터가 변경되었습니다. 삭제 대상을 다시 확인해 주세요.', 409, 'STALE_DELETION');
        let backupPath;
        try { backupPath = await backupDb(store.db, backupDir); }
        catch { fail('백업을 완료하지 못해 삭제하지 않았습니다. 서버 백업 폴더와 저장 공간을 확인해 주세요.', 500, 'BACKUP_FAILED'); }
        admin(); const deleted = store.deleteAllSchedules(input.revision);
        return json({ deleted, backupFile: basename(backupPath) });
      }
      if (path === '/api/logout' && req.method === 'POST') { store.db.prepare('DELETE FROM sessions WHERE token=?').run(session.token); cookie(''); return json({ ok: true }); }
      if (path === '/api/users' && req.method === 'POST') { admin(); const d = await body(req); admin(); return json(store.addUser(d.login, d.name, hashPassword(d.password), d.role || 'member'), 201); }
      const userEdit = /^\/api\/users\/([^/]+)$/.exec(path);
      if (userEdit && req.method === 'PUT') {
        admin(); const d = await body(req); admin();
        const hash = d.password === undefined || d.password === '' ? undefined : hashPassword(d.password);
        return json(store.updateUser(userEdit[1], d, hash));
      }
      if (userEdit && req.method === 'DELETE') { admin(); return json(store.removeUser(userEdit[1], session.user.id)); }
      if (path === '/api/state' && req.method === 'GET') {
        const year = Number(url.searchParams.get('year'));
        if (url.searchParams.has('start') && url.searchParams.has('end')) {
          await holidaySync.refresh(reportYears(url.searchParams.get('start'), url.searchParams.get('end')));
        } else if (year >= 2000 && year <= 2100) await holidaySync.refresh([year - 1, year, year + 1].filter(y => y >= 2000));
        return json({ equipment: EQUIPMENT, users: store.users(), testTimeStandards:store.testTimeStandards(), reservations: store.reservations().map(r => ({ ...r, plannedMinutes:r.status==='취소'?0:operatingMinutes(r,store.rules()), intervals: r.status === '취소' ? [] : expandReservation(r, store.rules(), { validateOperatingDays: false }) })), actuals: store.actuals().map(a => ({ ...a, intervals: a.zero ? [] : expandReservation(actualReservation(store.reservation(a.reservationId),a,store.rules()), { ...store.rules(), holidays: [] }) })), baselines: store.baselines(), downtimes: store.downtimes(), rules: store.rules(), holidayYears: store.holidayYears(), holidaySync: holidaySync.status(), customHolidays: store.customHolidays() });
      }
      if (path === '/api/equipment' && req.method === 'GET') return json(EQUIPMENT);
      if (path === '/api/reservations' && req.method === 'GET') return json(store.reservations());
      if (path === '/api/reservations' && req.method === 'POST') return json(store.saveReservation(await body(req), session.user.id), 201);
      const history = /^\/api\/reservations\/([^/]+)\/history$/.exec(path);
      if (history && req.method === 'GET') return json(store.history(history[1]));
      const deletionPreview = /^\/api\/reservations\/([^/]+)\/deletion-preview$/.exec(path);
      if (deletionPreview && req.method === 'GET') return json(store.reservationDeletionPreview(deletionPreview[1], session.user.id));
      const edit = /^\/api\/reservations\/([^/]+)$/.exec(path);
      if (edit && req.method === 'PUT') return json(store.saveReservation(await body(req), session.user.id, edit[1]));
      if (edit && req.method === 'DELETE') {
        const input = await body(req); const actor = authenticated().user;
        if (input.confirmation !== '시험 삭제') fail('시험 삭제 확인이 필요합니다.');
        if (input.revision !== store.reservationDeletionPreview(edit[1], actor.id).revision) fail('시험 정보나 실적이 변경되었습니다. 상세 창을 다시 열고 삭제해 주세요.', 409, 'STALE_DELETION');
        let backupPath;
        try { backupPath = await backupDb(store.db, backupDir); }
        catch { fail('백업을 완료하지 못해 삭제하지 않았습니다. 서버 백업 폴더와 저장 공간을 확인해 주세요.', 500, 'BACKUP_FAILED'); }
        return json({ ...store.deleteReservation(edit[1], input.revision, authenticated().user.id), backupFile: basename(backupPath) });
      }
      if (path === '/api/actuals' && req.method === 'POST') return json(store.saveActual(await body(req), session.user.id));
      if (/^\/api\/actuals\/[^/]+$/.test(path) && req.method === 'DELETE') { store.removeActual(path.split('/').at(-1)); return json({ ok: true }); }
      if (path === '/api/baselines' && req.method === 'POST') { admin(); return json(store.saveBaseline((await body(req)).month, session.user.id), 201); }
      if (path === '/api/downtimes' && req.method === 'POST') { admin(); return json(store.saveDowntime(await body(req), session.user.id), 201); }
      if (/^\/api\/downtimes\/[^/]+$/.test(path) && req.method === 'DELETE') { admin(); store.removeDowntime(path.split('/').at(-1)); return json({ ok: true }); }
      if (path === '/api/settings' && req.method === 'PUT') { admin(); return json(store.saveRules(await body(req))); }
      if (path === '/api/holidays' && req.method === 'POST') { admin(); return json(store.saveHoliday(await body(req)), 201); }
      if (path === '/api/holidays/key' && req.method === 'POST') { admin(); const input = await body(req); store.saveHolidayApiKey(input.key); holidaySync.failures.clear(); return json(await holidaySync.refresh(currentYears(), { force: true })); }
      if (path === '/api/holidays/sync' && req.method === 'POST') { admin(); const input = await body(req), year = Number(input.year); if (input.start && input.end) return json(await holidaySync.refresh(reportYears(input.start, input.end), { force: true })); if (!Number.isInteger(year) || year < 2000 || year > 2100) fail('갱신할 연도를 확인해 주세요.'); return json(await holidaySync.refresh([...currentYears(), year], { force: true })); }
      if (/^\/api\/holidays\/\d{4}-\d{2}-\d{2}$/.test(path) && req.method === 'DELETE') { admin(); store.removeHoliday(path.split('/').at(-1)); return json({ ok: true }); }
      if (path === '/api/capacity' && req.method === 'GET') {
        const start = url.searchParams.get('start'), end = url.searchParams.get('end'); reportYears(start, end);
        const all = store.reservations(), actuals = store.actuals(), rules = store.rules(), stops = store.downtimes(), originals = store.originalPlans();
        const periodStart = new Date(start).getTime(), periodEnd = new Date(end).getTime();
        const overlaps = intervals => intervals.some(([a, b]) => a < periodEnd && b > periodStart);
        return json(EQUIPMENT.map(e => {
          const bookings = all.filter(r => r.equipmentId === e.id && r.status !== '취소' && r.start < new Date(end).toISOString() && r.end > new Date(start).toISOString());
          const cap = capacity({ equipmentId: e.id, start, end, reservations: bookings, rules, downtimes: stops.filter(d => d.equipmentId === e.id) });
          const recorded = bookings.flatMap(r => { const a = actuals.find(a => a.reservationId === r.id); return a && !a.zero ? [actualReservation(r,a,rules)] : []; });
          const actualMinutes = capacity({ equipmentId: e.id, start, end, reservations: recorded, rules: { ...rules, holidays: [] }, downtimes: stops.filter(d => d.equipmentId === e.id) }).plannedMinutes;
          const originalBookings = originals.filter(r => r.equipmentId === e.id && (r.plannedIntervals ? overlaps(r.plannedIntervals) : new Date(r.start).getTime() < periodEnd && new Date(r.end).getTime() > periodStart));
          const unknownOriginalPlans = originalBookings.filter(r => r.plannedIntervals === null).length;
          const originalPlanMinutes = unknownOriginalPlans ? null : merge(originalBookings.flatMap(r => r.plannedIntervals)).reduce((total, [a, b]) => total + Math.max(0, Math.min(b, periodEnd) - Math.max(a, periodStart)) / 60000, 0);
          const expected = new Set([...originalBookings, ...bookings.filter(r => overlaps(activeIntervals(r, rules)))].filter(r => all.find(current => current.id === r.id)?.status !== '취소').map(r => r.id));
          const originalMissingActuals = [...expected].filter(id => !actuals.some(a => a.reservationId === id)).length;
          return { ...e, ...cap, actualMinutes, originalPlanMinutes, originalMissingActuals, unknownOriginalPlans,
            originalAchievementPercent: originalPlanMinutes > 0 ? actualMinutes / originalPlanMinutes * 100 : null,
            missingActuals: bookings.filter(r => !actuals.some(a => a.reservationId === r.id)).length, totalBookings: bookings.length };
        }));
      }
      if (path === '/api/export' && req.method === 'GET') {
        const start = url.searchParams.get('start'), end = url.searchParams.get('end'); reportYears(start, end);
        const rows = store.reservations().filter(r => r.start < new Date(end).toISOString() && r.end > new Date(start).toISOString()).map(r => {
          const a = store.actuals().find(a => a.reservationId === r.id);
          return { 시험명: r.title, 프로젝트: r.project, 시험실: EQUIPMENT.find(e => e.id === r.equipmentId).name, 시험종류: r.testType, 담당자: store.users().find(u => u.id === r.ownerId)?.name, 시작: new Date(r.start), 종료: new Date(r.end), 상태: r.status, 실적: !a ? '미입력' : a.zero ? '0시간' : '입력', 실제시작: a?.start ? new Date(a.start) : '', 실제종료: a?.end ? new Date(a.end) : '', 비고: r.note, 주말포함: r.includeWeekend ? '포함' : r.equipmentId === 'endurance' ? '연속 가동' : '기본 운영일', 계획가동시간:r.status==='취소'?0:operatingMinutes(r,store.rules())/60 };
        });
        const sheet = rows.length ? XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'yyyy-mm-dd hh:mm' }) : XLSX.utils.aoa_to_sheet([['시험명', '프로젝트', '시험실', '시험종류', '담당자', '시작', '종료', '상태', '실적']]);
        // Excel stores dates without a timezone; export Korea wall-clock values.
        for (const cell of Object.values(sheet)) if (cell?.t === 'd') { cell.t = 'n'; cell.v = (cell.v.getTime() + 9 * 3600000 - Date.UTC(1899, 11, 30)) / 86400000; cell.z = 'yyyy-mm-dd hh:mm'; }
        sheet['!cols'] = [32, 20, 26, 22, 15, 22, 22, 12, 12, 22, 22, 40, 15].map(wch => ({ wch }));
        const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '시험계획');
        res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename="lab-schedule.xlsx"' }); return res.end(XLSX.write(book, { type: 'buffer', bookType: 'xlsx', cellDates: true }));
      }
      fail('요청을 찾을 수 없습니다.', 404);
    } catch (e) { if (!e.status) console.error(e); json({ code: e.code, error: e.status ? e.message : '처리 중 문제가 발생했습니다. 입력을 확인해 주세요.' }, e.status || (e instanceof RangeError ? 400 : 500)); }
  });
  let holidayTimer;
  server.on('listening', () => {
    void holidaySync.refresh(currentYears());
    holidayTimer = setInterval(() => { void holidaySync.refresh([...currentYears(), ...Object.keys(store.holidayCache()).map(Number)]); }, 6 * 3600000);
    holidayTimer.unref();
  });
  server.on('close', () => clearInterval(holidayTimer));
  return { server, store, holidaySync };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbPath = process.env.DB_PATH || resolve(ROOT, 'data/lab.sqlite'); await mkdir(dirname(dbPath), { recursive: true });
  const { server } = createApp({ dbPath });
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 4317);
  server.listen(port, host, () => console.log(`Lab Planner: http://${host}:${port}`));
}
