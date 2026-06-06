import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { useCookingCalendar } from '../cooking/queries.js';
import { useAttribution } from '../cooking/useAttribution.js';
import { CalendarMonth, selectedDateLabel, type CalendarBadge } from '../cooking/CalendarMonth.js';
import { monthGridRange, todayISO } from '../cooking/dateGrid.js';
import { occasionLabel } from '../cooking/format.js';
import type { CalendarEntry } from '../local/repositories.js';

export function CookingTrackerPage() {
  const { user } = useAuth();
  const attribute = useAttribution();
  const todayIso = todayISO();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState<string>(todayIso);

  const range = useMemo(() => monthGridRange(year, month), [year, month]);
  const { data: entries = [] } = useCookingCalendar(range);

  const entriesByDate = useMemo(() => {
    const map = new Map<string, CalendarBadge[]>();
    for (const e of entries) {
      const arr = map.get(e.eventDate) ?? [];
      arr.push({ mine: e.ownerId === user?.id });
      map.set(e.eventDate, arr);
    }
    return map;
  }, [entries, user?.id]);

  const dayEntries = useMemo(
    () => entries.filter((e) => e.eventDate === selectedDate),
    [entries, selectedDate],
  );

  function prevMonth() {
    setMonth((m) => (m === 0 ? 11 : m - 1));
    if (month === 0) setYear((y) => y - 1);
  }
  function nextMonth() {
    setMonth((m) => (m === 11 ? 0 : m + 1));
    if (month === 11) setYear((y) => y + 1);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Cooking tracker</h1>
        <Link to="/cooking/recent" className="text-sm text-stone-600 hover:underline dark:text-stone-400">
          Recently viewed →
        </Link>
      </div>
      <p className="flex items-center gap-3 text-xs text-stone-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-stone-800 dark:bg-stone-200" /> You
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> Household
        </span>
      </p>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4">
          <CalendarMonth
            year={year}
            month={month}
            entriesByDate={entriesByDate}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            onPrevMonth={prevMonth}
            onNextMonth={nextMonth}
          />
        </div>

        <div data-testid="calendar-day-detail">
          <h2 className="text-base font-semibold">{selectedDateLabel(selectedDate)}</h2>
          {dayEntries.length === 0 ? (
            <p className="mt-2 text-sm text-stone-500">Nothing cooked or planned for this day.</p>
          ) : (
            <ul className="mt-2 divide-y divide-stone-200 dark:divide-stone-700 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
              {dayEntries.map((e) => (
                <CalendarDayEntry key={e.id} entry={e} attributedTo={attribute(e.ownerId)} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function CalendarDayEntry({ entry, attributedTo }: { entry: CalendarEntry; attributedTo: string }) {
  const title = entry.recipeTitle ?? entry.recipeSnapshot?.title ?? 'Recipe';
  const linkable = entry.collectionId && entry.recipeId;
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            entry.status === 'COOKED'
              ? 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300'
              : 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200'
          }`}
        >
          {entry.status === 'COOKED' ? 'Made' : 'Planned'}
        </span>
        {linkable ? (
          <Link
            to={`/collections/${entry.collectionId}/recipes/${entry.recipeId}`}
            className="font-medium hover:underline"
          >
            {title}
          </Link>
        ) : (
          <span className="font-medium">{title}</span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-stone-500">
        {attributedTo}
        {entry.occasionCategory ? ` · ${occasionLabel(entry.occasionCategory)}` : ''}
        {entry.occasionNote ? ` · ${entry.occasionNote}` : ''}
      </p>
      {entry.notes && (
        <p className="mt-0.5 text-sm text-stone-600 dark:text-stone-400">{entry.notes}</p>
      )}
    </li>
  );
}
