import { newCookingEventId, type Recipe } from '@cookyourbooks/domain';
import { useState } from 'react';

import { useAuth } from '../auth/AuthProvider.js';
import { type CookMode, LogCookDialog } from './LogCookDialog.js';
import { uploadCookingPhoto } from './photos.js';
import { useLogCook, useScheduleCook } from './queries.js';

/**
 * Primary cooking actions on the recipe page: "I made this" and
 * "Schedule a cook". Both open the same dialog in the matching mode.
 */
export function CookingPanel({ recipe }: { recipe: Recipe }) {
  const { user } = useAuth();
  const [mode, setMode] = useState<CookMode | null>(null);
  const [uploading, setUploading] = useState(false);
  const logCook = useLogCook();
  const scheduleCook = useScheduleCook();

  const busy = uploading || logCook.isPending || scheduleCook.isPending;

  return (
    <section
      className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4"
      data-testid="cooking-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Cooking</h2>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setMode('made')}
            className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300"
            data-testid="i-made-this"
          >
            I made this
          </button>
          <button
            type="button"
            onClick={() => setMode('schedule')}
            className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
            data-testid="schedule-cook"
          >
            Schedule a cook
          </button>
        </div>
      </div>

      {mode && (
        <LogCookDialog
          recipe={recipe}
          mode={mode}
          busy={busy}
          onClose={() => setMode(null)}
          onSubmit={async ({ photos, ...input }) => {
            // Mint the event id up front so photos upload into its folder,
            // then persist the event carrying the resulting paths.
            const id = newCookingEventId();
            let photoPaths: string[] = [];
            if (photos.length > 0 && user) {
              setUploading(true);
              try {
                photoPaths = await Promise.all(
                  photos.map((file) => uploadCookingPhoto(user.id, id, file)),
                );
              } finally {
                setUploading(false);
              }
            }
            const mutation = mode === 'made' ? logCook : scheduleCook;
            mutation.mutate(
              { id, recipe, photoPaths, ...input },
              { onSuccess: () => setMode(null) },
            );
          }}
        />
      )}
    </section>
  );
}
