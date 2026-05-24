import type { ParsedRecipeDraft } from '@cookyourbooks/domain';

export type ImportItemStatus =
  | 'PENDING'
  | 'CLAIMED'
  | 'OCR_DONE'
  | 'NEEDS_FALLBACK'
  | 'OCR_FAILED'
  | 'REVIEWED'
  | 'DISCARDED';

export type RecitationPolicy = 'ASK' | 'FALLBACK' | 'FAIL';
export type BatchStatus = 'OPEN' | 'ARCHIVED';
export type SourceKind = 'IMAGES' | 'PDF';
export type OcrProvider = 'gemini' | 'openai-compatible';

export interface ImportBatch {
  id: string;
  ownerId: string;
  name: string;
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
  attempts: number;
  lastError: string | null;
  parsedDrafts: ParsedRecipeDraft[];
  modelUsed: string | null;
  promptTokens: number;
  completionTokens: number;
  costUsdMicros: number;
  createdRecipeIds: string[];
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
