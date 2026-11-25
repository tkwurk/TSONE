import { useMemo, useState, type ReactNode } from 'react'

export interface Column<T> {
  key: string
  label: ReactNode
  render?: (row: T) => ReactNode
  align?: 'left' | 'right' | 'center'
  /** Enable click-to-sort on this column's header. */
  sortable?: boolean
  /** Value used for sorting; defaults to row[key]. */
  sortValue?: (row: T) => string | number
  /** Text used for filtering; defaults to String(row[key]). */
  filterValue?: (row: T) => string
}

export interface SortState {
  key: string
  dir: 'asc' | 'desc'
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/** Generic responsive table used by report/admin screens. Opt-in sort + filter. */
export function DataTable<T extends Record<string, unknown>>({
  columns,
  rows,
  rowKey,
  empty,
  defaultSort,
  filterable = false,
  filterPlaceholder,
  columnFilters,
  onRowClick,
  activeRowKey,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => string
  empty?: ReactNode
  /** Initial sort column/direction. */
  defaultSort?: SortState
  /** Show a search box that filters rows across all columns. */
  filterable?: boolean
  filterPlaceholder?: string
  /** Controlled header inputs; the caller applies the filters. */
  columnFilters?: {
    values: Record<string, string>
    onChange: (key: string, value: string) => void
    label: (columnLabel: ReactNode) => string
  }
  /** Makes rows clickable (mouse, Enter or Space), e.g. to open details. */
  onRowClick?: (row: T) => void
  /** rowKey of the row to highlight as selected. */
  activeRowKey?: string
}) {
  const [sort, setSort] = useState<SortState | null>(defaultSort ?? null)
  const [query, setQuery] = useState('')

  const colByKey = useMemo(() => {
    const m = new Map<string, Column<T>>()
    for (const c of columns) m.set(c.key, c)
    return m
  }, [columns])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) =>
      columns.some((c) => {
        const text = c.filterValue ? c.filterValue(row) : String(row[c.key] ?? '')
        return text.toLowerCase().includes(q)
      }),
    )
  }, [rows, columns, query])

  const sorted = useMemo(() => {
    if (!sort) return filtered
    const col = colByKey.get(sort.key)
    const accessor = (row: T): string | number =>
      col?.sortValue ? col.sortValue(row) : (row[sort.key] as string | number)
    const dir = sort.dir === 'asc' ? 1 : -1
    // Stable sort preserves incoming order for equal keys (secondary ordering).
    return [...filtered].sort((a, b) => {
      const c = compare(accessor(a) ?? '', accessor(b) ?? '')
      return c === 0 ? 0 : c * dir
    })
  }, [filtered, sort, colByKey])

  const toggleSort = (key: string) =>
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null
    })

  const arrow = (key: string) => (sort?.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '')

  const table =
    sorted.length === 0 && !columnFilters ? (
      <p className="muted">{empty ?? '—'}</p>
    ) : (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{ textAlign: c.align ?? 'left', cursor: c.sortable ? 'pointer' : undefined, userSelect: 'none' }}
                  onClick={c.sortable ? () => toggleSort(c.key) : undefined}
                  aria-sort={
                    c.sortable && sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                >
                  {c.label}
                  {c.sortable ? arrow(c.key) : ''}
                </th>
              ))}
            </tr>
            {columnFilters && (
              <tr>
                {columns.map((c) => (
                  <th key={c.key}>
                    <input
                      className="table-column-filter"
                      type="search"
                      aria-label={columnFilters.label(c.label)}
                      value={columnFilters.values[c.key] ?? ''}
                      onChange={(e) => columnFilters.onChange(c.key, e.target.value)}
                    />
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr
                key={rowKey(r, i)}
                className={onRowClick ? 'data-table__row--clickable' + (activeRowKey === rowKey(r, i) ? ' data-table__row--active' : '') : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                aria-current={onRowClick && activeRowKey === rowKey(r, i) ? 'true' : undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                onKeyDown={
                  onRowClick
                    ? (ev) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault()
                          onRowClick(r)
                        }
                      }
                    : undefined
                }
              >
                {columns.map((c) => (
                  <td key={c.key} style={{ textAlign: c.align ?? 'left' }}>
                    {c.render ? c.render(r) : String(r[c.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={columns.length}>{empty ?? '—'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    )

  if (!filterable) return table

  return (
    <div>
      <input
        className="table-filter"
        type="search"
        value={query}
        placeholder={filterPlaceholder ?? 'Filter…'}
        onChange={(e) => setQuery(e.target.value)}
      />
      {table}
    </div>
  )
}
