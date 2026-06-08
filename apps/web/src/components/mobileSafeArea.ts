// Shared mobile layout primitives. Centralizes the safe-area + tap-target
// magic strings that were duplicated across the camera / import surfaces so
// every full-screen mobile UI composes the same classes.

/** Top padding that clears the notch / status bar (min 0.75rem). */
export const SAFE_TOP = 'pt-[max(0.75rem,env(safe-area-inset-top))]';

/** Bottom padding that clears the home indicator (min 0.75rem). */
export const SAFE_BOTTOM = 'pb-[max(0.75rem,env(safe-area-inset-bottom))]';

/** Left padding that clears the notch / rounded corner in landscape (min 0.75rem). */
export const SAFE_LEFT = 'pl-[max(0.75rem,env(safe-area-inset-left))]';

/** Right padding that clears the notch / rounded corner in landscape (min 0.75rem). */
export const SAFE_RIGHT = 'pr-[max(0.75rem,env(safe-area-inset-right))]';

/** Both horizontal insets at once — composable convenience. */
export const SAFE_X = `${SAFE_LEFT} ${SAFE_RIGHT}`;

/** Apple HIG minimum interactive target. */
export const TAP_TARGET = 'min-h-[44px] min-w-[44px]';
