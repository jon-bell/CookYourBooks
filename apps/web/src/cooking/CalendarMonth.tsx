import { isSameDay, monthLabel, monthMatrix, parseISODate, toISODate } from './dateGrid.js';

export interface CalendarBadge {
  /** Whether this entry is the current user's (vs a household co-member's). */
  mine: boolean;
}

/**
 * Native-Date month grid. Pure presentational: the parent supplies
 * `entriesByDate` (ISO date -> badges) and handles selection/navigation.
 * Week starts Sunday. All date math is local (no UTC shift).
 */
export function CalendarMonth({
  year,
  month,
  entriesByDate,
  selectedDate,
  onSelectDate,
  onPrevMonth,
  onNextMonth,
}: {
  year: number;
  month: number;
  entriesByDate: Map<string, CalendarBadge[]>;
  selectedDate?: string;
  onSelectDate: (iso: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
}) {
  const weeks = monthMatrix(year, month);
  const today = new Date();

  return (
    <div data-testid="calendar-month">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={onPrevMonth}
          aria-label="Previous month"
          className="rounded-md px-2 py-1 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          ‹
        </button>
        <h2 className="text-base font-semibold" data-testid="calendar-title">
          {monthLabel(year, month)}
        </h2>
        <button
          type="button"
          onClick={onNextMonth}
          aria-label="Next month"
          className="rounded-md px-2 py-1 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs text-stone-500">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div key={d} className="py-1">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {weeks.flat().map((day) => {
          const iso = toISODate(day);
          const badges = entriesByDate.get(iso) ?? [];
          const inMonth = day.getMonth() === month;
          const isToday = isSameDay(day, today);
          const isSelected = selectedDate === iso;
          const count = badges.length;
          const label = `${day.toLocaleDateString(undefined, {
            month: 'long',
            day: 'numeric',
          })}, ${count} cook${count === 1 ? '' : 's'}`;
          return (
            <button
              key={iso}
              type="button"
              aria-label={label}
              aria-pressed={isSelected}
              onClick={() => onSelectDate(iso)}
              className={[
                'flex min-h-14 flex-col items-center rounded-md border p-1 text-sm',
                inMonth
                  ? 'border-stone-200 dark:border-stone-700'
                  : 'border-transparent text-stone-400',
                isSelected
                  ? 'bg-stone-100 dark:bg-stone-800'
                  : 'hover:bg-stone-50 dark:hover:bg-stone-900',
                isToday ? 'ring-2 ring-stone-400' : '',
              ].join(' ')}
            >
              <span className={isToday ? 'font-semibold' : ''}>{day.getDate()}</span>
              {count > 0 && (
                <span className="mt-1 flex flex-wrap justify-center gap-0.5">
                  {badges.slice(0, 4).map((b, i) => (
                    <span
                      key={i}
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        b.mine ? 'bg-stone-800 dark:bg-stone-200' : 'bg-emerald-500'
                      }`}
                    />
                  ))}
                  {count > 4 && <span className="text-[10px] leading-none">+{count - 4}</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Convenience for callers: title for a selected ISO date. */
export function selectedDateLabel(iso: string): string {
  return parseISODate(iso).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
