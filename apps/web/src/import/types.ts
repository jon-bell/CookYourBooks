// Shared types for the bulk OCR pipeline. The error-kind enum mirrors
// the check constraint on `import_item_attempts.error_kind`.

export type OcrErrorKind =
  | 'OK'
  | 'RECITATION'
  | 'RATE_LIMIT'
  | 'AUTH'
  | 'NETWORK'
  | 'PARSE'
  | 'TIMEOUT'
  | 'OTHER';

export const OCR_ERROR_KINDS: readonly OcrErrorKind[] = [
  'OK',
  'RECITATION',
  'RATE_LIMIT',
  'AUTH',
  'NETWORK',
  'PARSE',
  'TIMEOUT',
  'OTHER',
];
