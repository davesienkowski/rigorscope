// Independent parser for the `cost` text output (plan 01-08). A helper, not a test: it imports nothing from
// src/. It throws on any line it does not recognize, so a format drift fails loudly instead of being skipped.
const FOOTER_KEYS = [
  'labels (otel rows)', 'labels', 'by-labels', 'scope', 'conservation', 'counts', 'totals', 'pricing', 'notional',
  'window', 'join', 'roles', 'otel-only', 'crosscheck', 'error-band', 'rules',
];
const HEADING_RE = /^(otel-only calls|harness calls) \(/;
const DIMS = ['role', 'model', 'effort', 'day', 'session', 'repo'];

// -> { noRows, freshness: { first, lines }, period, windowUsage, header, blocks: [{ heading, rows, total }],
//      totalsCheck, footer: { key: [lines] } }
export function parseCostTable(stdout) {
  const lines = stdout.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let i = 0;
  const out = {
    noRows: false, freshness: { first: null, lines: [] }, period: null, windowUsage: null, header: null, blocks: [], totalsCheck: null, footer: {},
  };
  if (!lines[i]?.startsWith('freshness:')) throw new Error('cost output does not start with a freshness line');
  out.freshness.first = lines[i];
  out.freshness.lines.push(lines[i]);
  i += 1;
  while (i < lines.length && lines[i].startsWith('  ')) { out.freshness.lines.push(lines[i]); i += 1; }
  if (!lines[i]?.startsWith('period:')) throw new Error('no period line after the freshness block');
  out.period = lines[i];
  i += 1;
  if (lines[i] === 'no rows') {
    out.noRows = true;
    if (i + 1 !== lines.length) throw new Error('lines after "no rows"');
    return out;
  }
  if (lines[i]?.startsWith('window usage:')) { out.windowUsage = lines[i]; i += 1; }
  const header = lines[i]?.trim().split(/\s+/);
  if (!header || !DIMS.includes(header[0]) || !header.includes('calls') || !header.includes('window_7d')) {
    throw new Error('no table header');
  }
  out.header = header;
  i += 1;
  let block = { heading: null, rows: [], total: null };
  out.blocks.push(block);
  for (; i < lines.length && !lines[i].startsWith('totals check:'); i += 1) {
    const line = lines[i];
    if (HEADING_RE.test(line)) {
      block = { heading: line, rows: [], total: null };
      out.blocks.push(block);
      continue;
    }
    const cells = line.trim().split(/\s+/);
    if (cells.length !== header.length) throw new Error(`table row ${i} has ${cells.length} cells, header has ${header.length}`);
    const row = Object.fromEntries(header.map((h, k) => [h, cells[k]]));
    if (cells[0] === '=total') block.total = row; else block.rows.push(row);
  }
  if (i >= lines.length) throw new Error('no totals check line');
  out.totalsCheck = lines[i];
  i += 1;
  let last = null;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('  ') && last !== null) { out.footer[last].push(line); continue; }
    const key = FOOTER_KEYS.find((k) => line.startsWith(`${k}:`));
    if (!key) throw new Error(`unrecognized footer line ${i}`);
    if (out.footer[key]) throw new Error(`footer line ${key} appears twice`);
    out.footer[key] = [line];
    last = key;
  }
  return out;
}

// Footer keys in print order, for order assertions.
export const FOOTER_ORDER = FOOTER_KEYS.filter((k) => k !== 'labels (otel rows)');
export const footerKeysInOrder = (parsed) => Object.keys(parsed.footer);
