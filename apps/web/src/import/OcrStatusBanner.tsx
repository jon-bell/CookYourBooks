import { useEffect, useMemo, useState } from 'react';
import type { ImportItem } from './model.js';
import {
  computeBatchQueueInfo,
  describeOcrQueueInfo,
  isOcrInProgress,
} from './ocrStatus.js';

export function OcrStatusBanner({
  item,
  batchItems,
}: {
  item: Pick<
    ImportItem,
    'id' | 'status' | 'pageIndex' | 'updatedAt' | 'attempts' | 'claimExpiresAt' | 'lastError'
  >;
  batchItems: Array<Pick<ImportItem, 'id' | 'status' | 'pageIndex'>>;
}) {
  const active = isOcrInProgress(item.status);
  const now = useTickingNow(active);

  const info = useMemo(
    () => computeBatchQueueInfo(item, batchItems, now),
    [item, batchItems, now],
  );

  if (!info) return null;

  const { title, detail } = describeOcrQueueInfo(info);
  const processing = info.status === 'CLAIMED';

  return (
    <div
      role="status"
      className={`rounded-md border p-3 text-sm ${
        processing
          ? 'border-blue-200 bg-blue-50 text-blue-900'
          : 'border-stone-300 bg-stone-50 text-stone-800'
      }`}
    >
      <div className="flex items-center gap-2 font-medium">
        {processing && (
          <span
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-blue-700"
            aria-hidden
          />
        )}
        {title}
      </div>
      <div className="mt-1 text-xs opacity-90">{detail}</div>
    </div>
  );
}

function useTickingNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
