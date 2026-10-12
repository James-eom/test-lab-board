const ENDPOINT = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';
const DAY = 86400000;
class HolidayDataError extends Error {}
const value = (xml, tag) => xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();
const decode = text => text.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => entity[0] === '#' ? String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity.toLowerCase()]);

export function parseHolidays(xml, year) {
  if (typeof xml !== 'string' || xml.length > 2000000 || value(xml, 'resultCode') !== '00') throw new HolidayDataError('공휴일 API가 정상 응답하지 않았습니다. 인증키 승인·만료 상태를 확인해 주세요.');
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  const total = Number(value(xml, 'totalCount'));
  if (!Number.isInteger(total) || total < 1 || total > 100 || items.length !== total) throw new HolidayDataError('해당 연도의 공휴일 자료가 없거나 응답이 불완전합니다. 기존 자료를 유지합니다.');
  const holidays = new Map();
  for (const item of items) {
    const day = value(item, 'locdate'), name = decode(value(item, 'dateName') || ''), flag = value(item, 'isHoliday');
    if (!/^\d{8}$/.test(day || '') || !day.startsWith(String(year)) || !name || name.length > 100 || !['Y', 'N'].includes(flag)) throw new HolidayDataError('공휴일 API 자료 형식이 올바르지 않습니다. 기존 자료를 유지합니다.');
    const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`;
    if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new HolidayDataError('공휴일 API 날짜가 올바르지 않습니다.');
    if (flag === 'Y') {
      const previous = holidays.get(date);
      holidays.set(date, { date, name: previous ? `${previous.name} / ${name}` : name, source: 'api' });
    }
  }
  if (!holidays.size) throw new HolidayDataError('해당 연도의 공휴일 자료가 없습니다. 기존 자료를 유지합니다.');
  return [...holidays.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export class HolidaySync {
  constructor(store, fetcher = fetch) { this.store = store; this.fetcher = fetcher; this.pending = new Map(); this.failures = new Map(); }
  status() {
    return { configured: !!this.store.holidayApiKey(), updating: this.pending.size > 0,
      years: Object.entries(this.store.holidayCache()).map(([year, c]) => ({ year: Number(year), updatedAt: c.updatedAt, count: c.holidays.length })),
      errors: [...this.failures].map(([year, e]) => ({ year, message: e.message })) };
  }
  async refresh(years, { force = false } = {}) {
    if (!this.store.holidayApiKey()) return this.status();
    await Promise.all([...new Set(years)].map(async year => {
      if (!Number.isInteger(year) || year < 2000 || year > 2100) return;
      if (this.pending.has(year)) { await this.pending.get(year); return; }
      const cache = this.store.holidayCache()[year], failure = this.failures.get(year);
      if (!force && ((cache && Date.now() - Date.parse(cache.updatedAt) < DAY) || (failure && Date.now() - failure.at < 3600000))) return;
      const task = this.fetchYear(year); this.pending.set(year, task);
      try { await task; } finally { this.pending.delete(year); }
    }));
    return this.status();
  }
  async fetchYear(year) {
    try {
      const url = new URL(ENDPOINT);
      url.search = new URLSearchParams({ ServiceKey: this.store.holidayApiKey(), solYear: String(year), numOfRows: '100', pageNo: '1' }).toString();
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) throw new HolidayDataError('공휴일 API에 연결하지 못했습니다. 인증키 승인·만료 또는 네트워크 상태를 확인해 주세요.');
      const holidays = parseHolidays(await response.text(), year);
      this.store.saveHolidayYear(year, holidays); this.failures.delete(year);
    } catch (e) {
      // Never expose request URLs or upstream errors: they can contain the key.
      const message = e instanceof HolidayDataError ? e.message : '공휴일 API 조회에 실패했습니다. 기존 자료를 유지하며 다음 확인 때 재시도합니다.';
      this.failures.set(year, { at: Date.now(), message });
    }
  }
}
