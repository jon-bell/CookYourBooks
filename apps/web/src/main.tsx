import './styles.css';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App.js';
import { AuthProvider } from './auth/AuthProvider.js';
import { FirstSyncOverlay } from './components/FirstSyncOverlay.js';
import { SchemaUpgradeOverlay } from './components/SchemaUpgradeOverlay.js';
import { ToastProvider } from './components/ToastProvider.js';
import { SyncProvider } from './local/SyncProvider.js';
import { initSentry, reportError, Sentry } from './sentry.js';
import { ThemeProvider } from './theme/ThemeProvider.js';

// Initialize before React renders so the first paint / route load is
// already instrumented; the Sentry ErrorBoundary below is what catches
// render-time exceptions and tags them with React component context.
initSentry();

// A rejected query/mutation (a Supabase 57014 statement timeout, an RLS
// denial, a network blip) is otherwise swallowed into the hook's error state
// and never reaches Sentry. Report the final failure (after retries) from the
// cache-level handlers so every data-layer error is captured with its
// query/mutation key + pg code. Skip the expected cases — offline, or a
// request aborted by a superseding render — so real signal isn't buried.
function isExpectedFailure(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return (err as { name?: string } | null | undefined)?.name === 'AbortError';
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err, query) => {
      if (isExpectedFailure(err)) return;
      const key = query.queryKey?.[0];
      reportError(err, {
        operation: 'query',
        tags: { query_key: typeof key === 'string' ? key : 'unknown' },
      });
    },
  }),
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      if (isExpectedFailure(err)) return;
      const key = mutation.options.mutationKey?.[0];
      reportError(err, {
        operation: 'mutation',
        tags: { mutation_key: typeof key === 'string' ? key : 'unknown' },
      });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary
      fallback={(errorData) => (
        <div
          role="alert"
          style={{
            padding: '2rem',
            maxWidth: 540,
            margin: '4rem auto',
            fontFamily: 'system-ui, sans-serif',
            lineHeight: 1.5,
          }}
        >
          <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Something went wrong</h1>
          <p>
            The error has been reported. You can reload to keep going — your local data is intact.
          </p>
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={() => {
                errorData.resetError();
                location.reload();
              }}
              style={{
                background: '#1c1917',
                color: 'white',
                border: 0,
                borderRadius: 6,
                padding: '0.5rem 0.875rem',
                cursor: 'pointer',
              }}
            >
              Reload
            </button>
          </div>
        </div>
      )}
    >
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <SyncProvider>
              <ToastProvider>
                <BrowserRouter>
                  <App />
                </BrowserRouter>
              </ToastProvider>
              {/* Blocking boot overlays — render above the app, self-gate on
                  whether there's slow migration / first-sync work to show. */}
              <SchemaUpgradeOverlay />
              <FirstSyncOverlay />
            </SyncProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);
