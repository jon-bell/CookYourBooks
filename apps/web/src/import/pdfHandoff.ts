/**
 * One-shot handoff of a picked PDF between import doors.
 *
 * The Upload-photos door forwards any PDF to the dedicated PDF page so a
 * single implementation decides "one recipe vs split by page" — but a File
 * can't travel in a URL, and putting blobs in history state survives reloads
 * badly. A module-level slot is enough: it lives across the SPA navigation and
 * is simply empty after a reload, where the PDF page falls back to its picker.
 */
let pending: File | undefined;

export function setPendingPdf(file: File): void {
  pending = file;
}

/** Returns the handed-off PDF once, clearing it. */
export function takePendingPdf(): File | undefined {
  const f = pending;
  pending = undefined;
  return f;
}
