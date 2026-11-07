// Deliberately leaking stand-ins for the usage picks (plan 01-06, D-11a). The canary and the usage tests
// inject them through the seams ctx.options.usagePick and ctx.options.usageReportPick to prove the raw-byte
// scan has teeth for the main Claude Code config file and for transcript usageReport lines: each one writes
// the serialization of its WHOLE input into the `kind` of one limit entry, a column the real pick fills
// from a shape-checked value only.
//
// They build a structurally valid pick result by themselves and must not import anything from src/.
// Result shape (the real picks return the same): { status, snapshot, rejected } with
//   snapshot = { fetchedAtMs, windows: { five_hour, seven_day, seven_day_opus, seven_day_sonnet }, limits }
//   window   = { pct, resetsMs } or null
//   limit    = { kind, grp, percent, resetsMs, severity, isActive }

const NOW_MS = 1793034000000; // 2026-10-26T17:00:00Z, a fixed instant
const emptyWindows = () => ({ five_hour: null, seven_day: null, seven_day_opus: null, seven_day_sonnet: null });

export function leakyCachePick(parsed) {
  const c = parsed !== null && typeof parsed === 'object' ? parsed.cachedUsageUtilization : null;
  const fetchedAtMs = c !== null && typeof c === 'object' && Number.isSafeInteger(c.fetchedAtMs) ? c.fetchedAtMs : NOW_MS;
  return {
    status: 'ok',
    snapshot: {
      fetchedAtMs,
      windows: { ...emptyWindows(), five_hour: { pct: 1, resetsMs: NOW_MS + 3600000 } },
      limits: [{ kind: JSON.stringify(parsed), grp: null, percent: 1, resetsMs: NOW_MS + 3600000, severity: null, isActive: 1 }],
    },
    rejected: [],
  };
}

export function leakyReportPick(line) {
  if (line === null || typeof line !== 'object' || line.type !== 'system' || line.subtype !== 'local_command') {
    return { status: 'not_report', snapshot: null, rejected: [] };
  }
  const ts = Date.parse(line.timestamp);
  return {
    status: 'ok',
    snapshot: {
      fetchedAtMs: Number.isFinite(ts) ? ts : NOW_MS,
      windows: emptyWindows(),
      limits: [{ kind: JSON.stringify(line), grp: null, percent: 1, resetsMs: NOW_MS + 3600000, severity: 'leak', isActive: 0 }],
    },
    rejected: [],
  };
}
