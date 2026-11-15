import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../trpc/client';
import { ThinWorkerStatus } from '../components/thin-worker-status';

declare const fixture: { projectId: string; csrf: string };
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const client = trpc.createClient({ links: [httpBatchLink({ url: '/api/trpc', transformer: superjson, headers: () => ({ 'x-csrf-token': fixture.csrf }) })] });
createRoot(document.getElementById('root')!).render(<trpc.Provider client={client} queryClient={query}><QueryClientProvider client={query}><ThinWorkerStatus projectId={fixture.projectId} /></QueryClientProvider></trpc.Provider>);
