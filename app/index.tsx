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