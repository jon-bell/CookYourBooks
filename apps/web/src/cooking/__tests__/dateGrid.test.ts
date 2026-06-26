import { describe, expect, it } from 'vitest';

import {
  addDaysISO,
  isSameDay,
  monthGridRange,
  monthLabel,
  monthMatrix,
  parseISODate,
  toISODate,
} from '../dateGrid.js';

describe('toISODate / parseISODate', () => {
  it('round-trips a date in local time', () => {
    const d = new Date(2026, 5, 17); // 17 June 2026, local
    expect(toISODate(d)).toBe('2026-06-17');
    expect(toISODate(parseISODate('2026-06-17'))).toBe('2026-06-17');
  });

  it('does NOT shift the day for a late-evening local time (UTC off-by-one guard)', () => {
    // 23:00 local on the 17th must still format as the 17th, even though
    // toISOString() (UTC) could roll it to the 18th in positive offsets.
    const lateNight = new Date(2026, 5, 17, 23, 0, 0);
    expect(toISODate(lateNight)).toBe('2026-06-17');
  });

  it('zero-pads month and day', () => {
    expect(toISODate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('addDaysISO', () => {
  it('adds and subtracts across month boundaries', () => {
    expect(addDaysISO('2026-06-28', 7)).toBe('2026-07-05');
    expect(addDaysISO('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('monthMatrix', () => {
  it('produces a 6×7 grid starting on a Sunday', () => {
    const weeks = monthMatrix(2026, 5); // June 2026
    expect(weeks).toHaveLength(6);
    for (const w of weeks) expect(w).toHaveLength(7);
    // Every first column is a Sunday.
    for (const w of weeks) expect(w[0]!.getDay()).toBe(0);
  });

  it('includes the 1st of the month and leading days from the prior month', () => {
    // June 2026: the 1st is a Monday, so the grid's first cell is May 31.
    const weeks = monthMatrix(2026, 5);
    expect(toISODate(weeks[0]![0]!)).toBe('2026-05-31');
    const flat = weeks.flat().map(toISODate);
    expect(flat).toContain('2026-06-01');
    expect(flat).toContain('2026-06-30');
  });

  it('handles a leap-year February', () => {
    const flat = monthMatrix(2028, 1).flat().map(toISODate); // Feb 2028 (leap)
    expect(flat).toContain('2028-02-29');
  });
});

describe('monthGridRange', () => {
  it('spans the padded grid first and last day', () => {
    const { start, end } = monthGridRange(2026, 5);
    expect(start).toBe('2026-05-31');
    expect(end <= '2026-07-12').toBe(true);
    expect(start < end).toBe(true);
  });
});

describe('isSameDay', () => {
  it('ignores time of day', () => {
    expect(isSameDay(new Date(2026, 5, 17, 1), new Date(2026, 5, 17, 23))).toBe(true);
    expect(isSameDay(new Date(2026, 5, 17), new Date(2026, 5, 18))).toBe(false);
  });
});

describe('monthLabel', () => {
  it('formats month and year', () => {
    expect(monthLabel(2026, 5)).toBe('June 2026');
  });
});
