/**
 * Module-friendly hook around the paginated /api/data/rows endpoint.
 *
 * Wraps `fetchRowsPage` (services/sqlDataService.ts) with TanStack Query so
 * identical filter+page combinations are deduplicated and cached across
 * the app. Switching modules with the same active filters is free; the
 * underlying fetch only fires once.
 *
 * Usage:
 *   const { data, isLoading, error } = useRowsPage({
 *     from: '2025-04-01',
 *     to: '2025-06-30',
 *     voucherTypes: ['Sales', 'Sales Order'],
 *     limit: 100,
 *     offset: page * 100,
 *   });
 *   const rows = data?.rows ?? [];
 *   const total = data?.total ?? 0;
 *
 * Note: the cache key is derived from the filters object — make sure
 * primitive equality holds across renders. If you build the filters
 * object inside JSX, wrap with useMemo.
 */

import { useQuery } from '@tanstack/react-query';
import { fetchRowsPage } from '../sqlDataService';
import type { RowsPageFilters, RowsPageResponse } from '../sqlDataService';

const ROWS_PAGE_KEY = 'rows-page';

export const useRowsPage = (filters: RowsPageFilters, options?: { enabled?: boolean }) => {
  return useQuery<RowsPageResponse>({
    queryKey: [ROWS_PAGE_KEY, filters],
    queryFn: () => fetchRowsPage(filters),
    enabled: options?.enabled !== false,
  });
};

/**
 * Cache-key prefix exported so the import-completion handler can
 * invalidate every paginated rows query in one call:
 *
 *   import { useQueryClient } from '@tanstack/react-query';
 *   import { ROWS_PAGE_KEY } from 'services/hooks/useRowsPage';
 *   const qc = useQueryClient();
 *   await qc.invalidateQueries({ queryKey: [ROWS_PAGE_KEY] });
 */
export { ROWS_PAGE_KEY };
