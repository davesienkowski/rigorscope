// The per-section rows-sum-to-total check (plan 01-08, TRUST-01, TRUST-02). Pure: built-ins only.
// A cell is { sum, unknown }: sum is the known sum (null when no member is known) and unknown is the count of
// unknown members. For every column the sum of the displayed rows' known sums and unknown counts must equal the
// total row's; an unknown is never coerced to zero. A missing field is a failure, not a zero.
export const TOTAL_COLUMNS = Object.freeze(['input', 'output', 'cache_read', 'cache_write', 'notional_usd', 'window_5h', 'window_7d']);

const valid = (c) => c !== null && typeof c === 'object'
  && (c.sum === null || Number.isSafeInteger(c.sum)) && Number.isSafeInteger(c.unknown) && c.unknown >= 0;

// rows: [{ column: cell }], total: { column: cell } | null -> { ok, columns } (failing columns in TOTAL_COLUMNS order).
export function checkTotals({ rows, total }) {
  const columns = [];
  for (const col of TOTAL_COLUMNS) {
    const cells = rows.map((r) => r?.[col]);
    const t = total?.[col];
    if (cells.some((c) => !valid(c))) { columns.push(col); continue; }
    if (total === null || total === undefined) {
      if (rows.length > 0) columns.push(col);
      continue;
    }
    if (!valid(t)) { columns.push(col); continue; }
    const sum = cells.reduce((a, c) => a + (c.sum ?? 0), 0);
    const unknown = cells.reduce((a, c) => a + c.unknown, 0);
    if (sum !== (t.sum ?? 0) || unknown !== t.unknown) columns.push(col);
  }
  return { ok: columns.length === 0, columns };
}
