// Capture-time classification for a single scanned page. Lives in its own
// module so the camera UI, the scanPages orchestrator, and uploadBatch all
// share one type without a circular import (model.ts stays free of camera
// concerns).

/**
 * What kind of page this shot is.
 * - RECIPE: a normal recipe page (default).
 * - TOC: a table-of-contents / index page (sets import_items.is_toc → TOC_PROMPT).
 * - NOTES: prose / intro page — OCR'd as text and stored as a collection note.
 */
export type PageKind = 'RECIPE' | 'TOC' | 'NOTES';

export interface PageMarker {
  kind: PageKind;
  /**
   * This page continues the previous page's recipe. A continuation page does
   * NOT become its own import_item — at upload its image is folded into the
   * previous group-leader's `extra_storage_paths`, so the multi-page recipe
   * OCRs together in one LLM call (reuses the existing page-merge path).
   * `kind` is ignored for a continuation page; the leader's kind wins.
   */
  joinsPrevious: boolean;
}

export const DEFAULT_MARKER: PageMarker = { kind: 'RECIPE', joinsPrevious: false };

/** A captured page plus its capture-time marker. */
export interface ScannedPage {
  file: File;
  marker: PageMarker;
}

/** Wrap bare files (native multi-shot, web file-picker, e2e shim) as RECIPE pages. */
export function asScannedPages(files: readonly File[]): ScannedPage[] {
  return files.map((file) => ({ file, marker: { ...DEFAULT_MARKER } }));
}

export interface PageGroup {
  /** The page that becomes the import_items row. */
  leaderId: string;
  /** 0-based index among leaders (the item's page_index). */
  pageIndex: number;
  /** The leader's kind drives OCR; continuation pages' kinds are ignored. */
  kind: PageKind;
  /** Continuation page ids folded into this leader (its extra_storage_paths). */
  extraIds: string[];
}

/**
 * Group captured pages for upload: each page is its own leader unless it's
 * marked `joinsPrevious` AND has a predecessor, in which case it folds into the
 * previous leader (so a multi-page recipe OCRs in one call). A leading
 * `joinsPrevious` page (no predecessor) becomes its own leader rather than
 * being dropped. `pageIndex` is contiguous across leaders only.
 */
export function planPageGroups(
  pages: readonly { id: string; marker: PageMarker }[],
): PageGroup[] {
  const groups: PageGroup[] = [];
  for (const p of pages) {
    if (p.marker.joinsPrevious && groups.length > 0) {
      groups[groups.length - 1]!.extraIds.push(p.id);
    } else {
      groups.push({ leaderId: p.id, pageIndex: groups.length, kind: p.marker.kind, extraIds: [] });
    }
  }
  return groups;
}
