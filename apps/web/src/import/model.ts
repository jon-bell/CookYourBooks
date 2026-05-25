import type { ParsedRecipeDraft } from '@cookyourbooks/domain';

export type ImportItemStatus =
  | 'AWAITING_GROUPING'
  | 'BAKEOFF_PENDING'
  | 'BAKEOFF_READY'
  | 'PENDING'
  | 'CLAIMED'
  | 'OCR_DONE'
  | 'NEEDS_FALLBACK'
  | 'OCR_FAILED'
  | 'REVIEWED'
  | 'DISCARDED';

export type RecitationPolicy = 'ASK' | 'FALLBACK' | 'FAIL';
export type BatchStatus = 'OPEN' | 'ARCHIVED';
export type BatchKind = 'STANDARD' | 'BAKEOFF';
export type SourceKind = 'IMAGES' | 'PDF';
export type OcrProvider = 'gemini' | 'openai-compatible';

export interface ImportBatch {
  id: string;
  ownerId: string;
  name: string;
  batchKind: BatchKind;
  sourceKind: SourceKind;
  targetCollectionId: string | null;
  defaultModel: string;
  defaultProvider: OcrProvider;
  fallbackModel: string | null;
  fallbackProvider: OcrProvider | null;
  recitationPolicy: RecitationPolicy;
  status: BatchStatus;
  totalItems: number;
  updatedAt: number;
}

export interface ImportItem {
  id: string;
  batchId: string;
  ownerId: string;
  pageIndex: number;
  storagePath: string;
  thumbPath: string | null;
  sourcePdfPath: string | null;
  sourcePdfPage: number | null;
  assignedCollectionId: string | null;
  assignedPageNumber: number | null;
  isToc: boolean;
  status: ImportItemStatus;
  claimExpiresAt: number;
  attempts: number;
  lastError: string | null;
  parsedDrafts: ParsedRecipeDraft[];
  modelUsed: string | null;
  promptTokens: number;
  completionTokens: number;
  costUsdMicros: number;
  createdRecipeIds: string[];
  /** Winning bakeoff variant, set when user picks from BAKEOFF_READY. */
  selectedVariantId: string | null;
  /** Storage paths of additional scanned pages folded into this item
   *  via the merge action. The worker sends primary + extras to the
   *  LLM together so the recipe survives mid-recipe page breaks. */
  extraStoragePaths: string[];
  updatedAt: number;
}

export interface ImportItemAttempt {
  id: string;
  itemId: string;
  ownerId: string;
  attemptNo: number;
  provider: string;
  model: string;
  rawResponsePath: string | null;
  errorKind: string | null;
  errorMessage: string | null;
  promptTokens: number;
  completionTokens: number;
  costUsdMicros: number;
  latencyMs: number;
  startedAt: number;
  finishedAt: number | null;
}

export interface ImportTocEntry {
  id: string;
  batchId: string;
  itemId: string;
  ownerId: string;
  title: string;
  pageNumber: number | null;
  confidence: number;
  updatedAt: number;
}
