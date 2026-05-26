import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { AuthProvider } from './auth/AuthProvider.js';
import { SyncProvider } from './local/SyncProvider.js';
import { ThemeProvider } from './theme/ThemeProvider.js';
import { initSentry, Sentry } from './sentry.js';
import './styles.css';

// Initialize before React renders so the first paint / route load is
// already instrumented; the Sentry ErrorBoundary below is what catches
// render-time exceptions and tags them with React component context.
initSentry();

const queryClient = new QueryClient({
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
      fallback={({ resetError }) => (
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
          <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>
            Something went wrong
          </h1>
          <p>
            The error has been reported. You can reload to keep going — your
            local data is intact.
          </p>
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={() => {
                resetError();
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
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </SyncProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);
