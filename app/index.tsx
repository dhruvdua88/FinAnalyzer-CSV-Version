import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';

// Global query client. staleTime is set high because audit data only
// changes when the user explicitly re-imports — there's no upstream
// system pushing changes. gcTime keeps cached results around for 30 min
// so module switching is free.
//
// Modules that want fresher data can override per-query via
// `useQuery({ ..., staleTime: 0 })`. Modules that want to invalidate on
// import can call `queryClient.invalidateQueries()` from the import
// completion handler.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,        // 5 min — audit dataset is largely static between imports
      gcTime: 30 * 60 * 1000,          // 30 min — keep results so module switches are instant
      refetchOnWindowFocus: false,     // desktop app: focus doesn't mean stale
      refetchOnReconnect: false,       // local backend: no network to reconnect to
      retry: 1,                        // one retry is enough for a localhost backend
    },
  },
});

// Every module is lazy-loaded, so a tab left open across a deploy holds an
// index bundle pointing at chunk filenames that no longer exist — opening a
// module then dies with "Failed to fetch dynamically imported module". Vite
// fires `vite:preloadError` for exactly this; reload once to pick up the new
// build. One reload per tab session: if the chunk still 404s after reloading
// the deploy is genuinely broken, and the error must surface rather than spin
// the page in a refresh loop.
window.addEventListener('vite:preloadError', (event) => {
  const RELOADED = 'finanalyzer:chunk-reload';
  if (sessionStorage.getItem(RELOADED)) return; // already tried — let the error surface
  event.preventDefault();
  sessionStorage.setItem(RELOADED, '1');
  window.location.reload();
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);