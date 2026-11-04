/** Работа с датами. «День» магазина — календарная дата по Киеву (YYYY-MM-DD). */

export const TZ = "Europe/Kyiv";

/** Сегодняшняя дата по Киеву в формате YYYY-MM-DD. */
export function kyivToday(now: Date = new Date()): string {
  // en-CA даёт формат YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const WEEKDAYS_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS_GEN = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function parts(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(), wd: d.getUTCDay() };
}

/** «4 ноября, среда» */
export function formatDayLong(iso: string): string {
  const p = parts(iso);
  return `${p.day} ${MONTHS_GEN[p.m]}, ${WEEKDAYS[p.wd]}`;
}

/** «04.11.2026» */
export function formatDayShort(iso: string): string {
  const p = parts(iso);
  return `${String(p.day).padStart(2, "0")}.${String(p.m + 1).padStart(2, "0")}.${p.y}`;
}

export function weekdayShort(iso: string): string {
  return WEEKDAYS_SHORT[parts(iso).wd];
}
