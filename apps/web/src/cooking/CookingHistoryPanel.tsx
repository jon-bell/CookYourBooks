import type { Recipe } from '@cookyourbooks/domain';
import { useMemo } from 'react';

import { useAuth } from '../auth/AuthProvider.js';
import { CookEntryCard } from './CookEntryCard.js';
import { todayISO } from './dateGrid.js';
import { useCookingEvents } from './queries.js';
import { useAttribution } from './useAttribution.js';

/**
 * Per-recipe history + schedule. Splits a recipe's cooking events into
 * "Upcoming" (PLANNED, today or later) and "History" (everything else),
 * including household co-members' entries (attributed).
 */
export function CookingHistoryPanel({ recipe }: { recipe: Recipe }) {
  const { user } = useAuth();
  const { data: events = [], isLoading } = useCookingEvents(recipe.id);
  const attribute = useAttribution();

  const { upcoming, history } = useMemo(() => {
    const today = todayISO();
    const up = events
      .filter((e) => e.status === 'PLANNED' && e.eventDate >= today)
      .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
    const hist = events
      .filter((e) => !(e.status === 'PLANNED' && e.eventDate >= today))
      .sort((a, b) => b.eventDate.localeCompare(a.eventDate));
    return { upcoming: up, history: hist };
  }, [events]);

  if (isLoading) return null;
  if (events.length === 0) {
    return (
      <section className="space-y-2" data-testid="cooking-history">
        <h2 className="text-lg font-semibold">Cooking history</h2>
        <p className="text-sm text-stone-500">
          No cooks logged yet. Use “I made this” above to start your record.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4" data-testid="cooking-history">
      {upcoming.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Upcoming ({upcoming.length})</h2>
          <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
            {upcoming.map((e) => (
              <CookEntryCard
                key={e.id}
                event={e}
                recipe={recipe}
                attributedTo={attribute(e.ownerId)}
                canEdit={e.ownerId === user?.id}
              />
            ))}
          </ul>
        </div>
      )}

      {history.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">History ({history.length})</h2>
          <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
            {history.map((e) => (
              <CookEntryCard
                key={e.id}
                event={e}
                recipe={recipe}
                attributedTo={attribute(e.ownerId)}
                canEdit={e.ownerId === user?.id}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
