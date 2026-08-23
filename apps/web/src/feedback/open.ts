/**
 * Tiny pub/sub so anything can open the feedback dialog without the dialog
 * having to live in — or be prop-drilled from — every nav surface. The dialog
 * is mounted once at the app root; the header menu, the mobile sheet and the
 * keyboard shortcut all just fire this.
 */

const listeners = new Set<() => void>();

export function openFeedbackDialog(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // A misbehaving listener mustn't stop the others.
    }
  }
}

export function subscribeOpenFeedback(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
