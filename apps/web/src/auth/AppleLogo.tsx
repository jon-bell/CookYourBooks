// Canonical Apple glyph used by the "Sign in with Apple" button.
// Colors are inherited via fill="currentColor" so the same SVG works
// on both the black-on-light and white-on-dark button variants.
export function AppleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M16.365 1.43c0 1.14-.41 2.19-1.23 3.16-.99 1.18-2.19 1.88-3.49 1.79-.17-1.13.41-2.32 1.23-3.27.85-.98 2.27-1.7 3.49-1.68zM20.92 17.36c-.5 1.15-1.09 2.27-1.83 3.29-.94 1.34-2.27 3.01-3.93 3.03-1.48.03-1.86-.92-3.86-.92-2 0-2.42.9-3.86.95-1.6.05-2.81-1.45-3.74-2.78-2.6-3.83-4.59-10.84-1.92-15.57.91-1.61 2.54-2.62 4.3-2.65 1.46-.03 2.83.95 3.74.95.91 0 2.59-1.16 4.36-.99.74.03 2.83.3 4.17 2.27-3.51 1.94-2.96 6.97.57 8.42z" />
    </svg>
  );
}
