/**
 * Generic windowed list for large row sets.
 *
 * Wraps @tanstack/react-virtual so audit modules can render 100k+ rows at
 * 60 FPS without reaching for a third-party data grid. Renders only the
 * rows currently in the viewport plus a small overscan buffer.
 *
 * This is intentionally minimal — modules already have their own header,
 * filters, and styling. This component handles the windowed body only.
 *
 * Usage:
 *   <VirtualizedRows
 *     rows={rows}
 *     estimatedRowHeight={32}
 *     getRowKey={(r) => r.guid}
 *     renderRow={(row, index) => (
 *       <tr><td>{row.date}</td><td>{row.amount}</td></tr>
 *     )}
 *   />
 *
 * For grouped/expandable rows, flatten into a single array of "visible
 * rows" upstream and use the row's type to branch in renderRow. The
 * virtualizer doesn't care whether a row is a header or a detail line.
 *
 * If your row heights are truly variable (wrapped narrations, expanded
 * panels), pass `getRowHeight` instead of `estimatedRowHeight` and the
 * virtualizer will measure on render.
 */

import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export type VirtualizedRowsProps<T> = {
  rows: readonly T[];
  /** Used as the React key on each row wrapper. Should be stable. */
  getRowKey: (row: T, index: number) => string | number;
  /** Renders the row contents. Wrapped in a positioned div by the virtualizer. */
  renderRow: (row: T, index: number) => React.ReactNode;
  /** Approximate row height in px. Used for initial layout; rows are measured on render. */
  estimatedRowHeight?: number;
  /** Per-row height override. If omitted, estimatedRowHeight is used as the measured height. */
  getRowHeight?: (row: T, index: number) => number;
  /** Number of off-screen rows to render on each side. Default 8. */
  overscan?: number;
  /** Container height. Default '100%'. The container must have a bounded height for windowing to work. */
  height?: string | number;
  /** Class on the scroll container. */
  className?: string;
  /** Inline style on the scroll container. Merged with default `overflow: auto`. */
  style?: React.CSSProperties;
  /** Empty-state node when rows.length === 0. */
  emptyState?: React.ReactNode;
};

export function VirtualizedRows<T>({
  rows,
  getRowKey,
  renderRow,
  estimatedRowHeight = 32,
  getRowHeight,
  overscan = 8,
  height = '100%',
  className,
  style,
  emptyState,
}: VirtualizedRowsProps<T>) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: getRowHeight
      ? (index) => getRowHeight(rows[index], index)
      : () => estimatedRowHeight,
    overscan,
  });

  if (rows.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  const containerStyle: React.CSSProperties = {
    overflow: 'auto',
    height,
    ...style,
  };

  return (
    <div ref={scrollRef} className={className} style={containerStyle}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          return (
            <div
              key={getRowKey(row, virtualRow.index)}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {renderRow(row, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
