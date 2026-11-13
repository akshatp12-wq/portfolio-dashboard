// Date helpers on ISO yyyy-MM-dd strings (UTC-safe, date-only).
export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
export function* eachDay(from, to) {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}
export function monthStart(iso) { return iso.slice(0, 7) + '-01'; }
export function todayIso(tz = 'America/Chicago') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts; // en-CA gives yyyy-MM-dd
}
export function yearsBetween(a, b) { return daysBetween(a, b) / 365.25; }
