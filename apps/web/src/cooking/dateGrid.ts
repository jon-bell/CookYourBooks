// Pure date helpers for the cooking tracker. Everything works in
// LOCAL time and on date-only ISO strings ('YYYY-MM-DD') to dodge the
// classic UTC off-by-one (never use Date.prototype.toISOString(), which
// formats in UTC and can shift the day across a timezone boundary).

/** Format a Date as a local 'YYYY-MM-DD' string. */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a 'YYYY-MM-DD' string into a local Date at midnight. */
export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map((n) => Number(n));
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** Today as a local 'YYYY-MM-DD' string. */
export function todayISO(): string {
  return toISODate(new Date());
}

/** Add (or subtract) whole days to an ISO date, returning an ISO date. */
export function addDaysISO(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * A 6×7 grid of Dates covering the calendar month containing
 * (year, month), padded with leading/trailing days from adjacent months
 * so every row is a full week. Week starts on Sunday.
 */
export function monthMatrix(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1);
  // Back up to the Sunday on or before the 1st.
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const weeks: Date[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < 6; w += 1) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d += 1) {
      week.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** First / last ISO date of the padded 6-week grid for a given month. */
export function monthGridRange(year: number, month: number): { start: string; end: string } {
  const weeks = monthMatrix(year, month);
  return {
    start: toISODate(weeks[0]![0]!),
    end: toISODate(weeks[5]![6]!),
  };
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month]} ${year}`;
}
