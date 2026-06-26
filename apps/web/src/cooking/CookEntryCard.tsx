import type { Recipe } from '@cookyourbooks/domain';

import type { CookingEventRecord } from '../local/repositories.js';
import { AdjustmentSummary } from './AdjustmentSummary.js';
import { formatEventDate, mealSlotLabel, occasionLabel } from './format.js';
import { CookingPhotoThumb } from './photos.js';
import { useDeleteCook, useMarkCooked } from './queries.js';

/**
 * One cooking event row — date, attribution, occasion, notes, and the
 * recorded diff. Own PLANNED events get "Mark as cooked"; own events get
 * a delete. Shared (co-member) events are read-only.
 */
export function CookEntryCard({
  event,
  recipe,
  attributedTo,
  canEdit,
}: {
  event: CookingEventRecord;
  recipe?: Recipe;
  attributedTo: string;
  canEdit: boolean;
}) {
  const markCooked = useMarkCooked();
  const deleteCook = useDeleteCook();

  return (
    <li className="px-4 py-3" data-testid="cook-entry">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-stone-900 dark:text-stone-100">
              {formatEventDate(event.eventDate)}
            </span>
            <span className="text-stone-400">·</span>
            <span className="text-stone-500">{attributedTo}</span>
            {event.mealSlot && (
              <span className="rounded-full bg-sky-100 dark:bg-sky-900/50 px-2 py-0.5 text-xs text-sky-800 dark:text-sky-200">
                {mealSlotLabel(event.mealSlot)}
              </span>
            )}
            {event.occasionCategory && (
              <span className="rounded-full bg-stone-100 dark:bg-stone-800 px-2 py-0.5 text-xs text-stone-600 dark:text-stone-300">
                {occasionLabel(event.occasionCategory)}
              </span>
            )}
          </div>
          {event.occasionNote && (
            <p className="mt-0.5 text-sm text-stone-600 dark:text-stone-400">
              {event.occasionNote}
            </p>
          )}
          {event.notes && (
            <p className="mt-0.5 whitespace-pre-wrap text-sm text-stone-700 dark:text-stone-300">
              {event.notes}
            </p>
          )}
          <AdjustmentSummary adjustments={event.adjustments} />
          {event.photoPaths.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2" data-testid="cook-photos">
              {event.photoPaths.map((p) => (
                <CookingPhotoThumb key={p} path={p} className="h-16 w-16 rounded-md object-cover" />
              ))}
            </div>
          )}
        </div>

        {canEdit && (
          <div className="flex shrink-0 flex-col items-end gap-1">
            {event.status === 'PLANNED' && recipe && (
              <button
                type="button"
                onClick={() => markCooked.mutate({ id: event.id, recipe })}
                disabled={markCooked.isPending}
                className="rounded-md border border-stone-300 dark:border-stone-600 px-2 py-1 text-xs hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
                data-testid="mark-cooked"
              >
                Mark as cooked
              </button>
            )}
            <button
              type="button"
              onClick={() => deleteCook.mutate({ id: event.id, photoPaths: event.photoPaths })}
              disabled={deleteCook.isPending}
              className="text-xs text-stone-500 hover:text-red-600 disabled:opacity-50"
              data-testid="delete-cook"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
