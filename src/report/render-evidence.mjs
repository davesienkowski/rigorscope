// Plain-text renderer for the evidence listing (plan 01-08, TRUST-04, D-08). It imports only src/measure modules.
// Every word printed here is a constant; the data strings are shape-checked ids, a root alias and a home-normalized
// relative path, and an absolute path is never printed.
import { freshnessLines } from '../measure/freshness.mjs';
import { allPeriod, formatPeriodLine } from '../measure/period.mjs';

export const EVIDENCE_NOTE = 'ordered by record time, then call id; transcript evidence names the file and message id, no line locator is stored; otel evidence adds the stored byte offset';

// header true: the freshness block and the period line first (the evidence command); false: the listing alone (cost --evidence).
export function renderEvidenceLines(e, { header = true } = {}) {
  const lines = [];
  if (header) {
    lines.push(...freshnessLines(e.freshnessCheck, { clockFixed: e.clockFixed === true }));
    lines.push(formatPeriodLine(e.period ?? allPeriod(), { tsUnknown: e.callsTsUnknown ?? 0 }));
  }
  lines.push(`evidence: row ${e.rowKey}`);
  lines.push(`calls=${e.calls} sessions=${e.sessions} listed=${e.listed} (${EVIDENCE_NOTE})`);
  for (const i of e.items) lines.push(...callLines(i));
  return lines;
}

function callLines(i) {
  const lines = [`call ${i.callKey}`];
  lines.push(
    `  session ${i.sessionId} agent ${i.agentId === '' || i.agentId === null ? '-' : i.agentId} message ${i.messageId ?? '-'} `
    + `request ${i.requestId ?? '?'} at ${i.tsUtc ?? '?'} occurrences ${i.occurrences}`,
  );
  for (const f of i.files) lines.push(`    file ${f.root}:${f.path}${f.offset === null || f.offset === undefined ? '' : ` offset ${f.offset}`}`);
  return lines;
}

// Plan 02-07 (D-19, D-04): the evidence of a unit id. A method row prints as method/confidence, followed by
// (base=<level> lowered_by=<rules> match=<how>) when a rule lowered it or it matched by directory name.
export const UNIT_EVIDENCE_NOTE = 'calls are the main-section calls attributed to the unit in this mode, ordered by record time, then call id';
const yesNo = (v) => (v ? 'yes' : 'no');
export function methodCell(m) {
  const extra = m.lowered_by !== null || m.match === 'dir-name'
    ? `(base=${m.base_confidence} lowered_by=${m.lowered_by ?? '-'} match=${m.match ?? '-'})` : '';
  return `${m.method}/${m.confidence}${extra}`;
}
const bucketText = (b) => (b ? `${b.bucket}/${b.reason}` : '?');

export function renderUnitEvidenceLines(e, { header = true } = {}) {
  const lines = [];
  if (header) {
    lines.push(...freshnessLines(e.freshnessCheck, { clockFixed: e.clockFixed === true }));
    lines.push(formatPeriodLine(e.period ?? allPeriod(), { tsUnknown: e.callsTsUnknown ?? 0 }));
  }
  lines.push(`evidence: unit ${e.evidenceId}`);
  const u = e.unit;
  lines.push(u === null ? 'unit none (no unit has this key)'
    : `unit key=${u.unit_key} repo=${u.repo} kind=${u.kind} id=${u.native_id} tier=${u.tier ?? '?'} `
      + `tier_signal=${u.tier_signal} tier_conflict=${yesNo(u.tier_conflict === 1)} git_evidence=${yesNo(u.git_evidence === 1)}`);
  lines.push(`links=${e.links.length} calls=${e.calls} scopes=${e.scopes} listed=${e.listed} link_confidence=${e.mode} (${UNIT_EVIDENCE_NOTE})`);
  for (const l of e.links) {
    lines.push(`link ${l.evidence_id} ${l.methods.map(methodCell).join(' ')} best=${l.confidence} `
      + `medium=${bucketText(l.attribution.medium)} low=${bucketText(l.attribution.low)}`);
  }
  for (const i of e.items) lines.push(...callLines(i));
  return lines;
}

export const renderUnitEvidenceText = (e, opts) => `${renderUnitEvidenceLines(e, opts).join('\n')}\n`;

export const renderEvidenceText = (e, opts) => `${renderEvidenceLines(e, opts).join('\n')}\n`;

// Plan 02-07 (D-19): the evidence of a link id. Times are UTC ISO instants; `?` is unknown.
const isoOf = (ms) => (ms === null || ms === undefined ? '?' : new Date(ms).toISOString());
export function renderLinkEvidenceLines(e, { header = true } = {}) {
  const lines = [];
  if (header) {
    lines.push(...freshnessLines(e.freshnessCheck, { clockFixed: e.clockFixed === true }));
    lines.push(formatPeriodLine(e.period ?? allPeriod(), { tsUnknown: 0 }));
  }
  lines.push(`evidence: link ${e.evidenceId}`);
  lines.push(`link unit=${e.unitKey} session=${e.sessionId} agent=${e.agentId === '' ? '-' : e.agentId} best=${e.best ?? '-'} `
    + `methods=${e.methods.length}`);
  const sc = e.scope;
  lines.push(sc === null ? `scope none medium=${bucketText(e.attribution.medium)} low=${bucketText(e.attribution.low)}`
    : `scope calls=${sc.calls} first=${isoOf(sc.first_ms)} last=${isoOf(sc.last_ms)} refs_known=${yesNo(sc.refs_known === 1)} `
      + `medium=${bucketText(e.attribution.medium)} low=${bucketText(e.attribution.low)}`);
  const u = e.unit;
  lines.push(u === null ? 'unit none (no unit has this key)'
    : `unit start=${isoOf(u.start_ms)} (${u.date_source}) end=${isoOf(u.end_ms)} (${u.end_source}) git_evidence=${yesNo(u.git_evidence === 1)}`);
  for (const m of e.methods) {
    const counts = m.method === 'tool-path' ? ` phase_level=${yesNo(m.phase_level === 1)} refs=${m.refs} write_refs=${m.write_refs}`
      : m.method === 'slash-command' ? ` instants=${m.instants}` : '';
    lines.push(`method ${methodCell(m)}${counts} first=${isoOf(m.first_ms)} last=${isoOf(m.last_ms)}`);
    if (m.method === 'tool-path') {
      for (const r of e.evidence.refs) lines.push(`  ref message ${r.message_id} ${r.ref_dir} ${r.rel_path} ${r.tool_name} n=${r.n}`);
      if (e.totals.refs > e.evidence.refs.length) lines.push(`  refs_omitted=${e.totals.refs - e.evidence.refs.length}`);
    }
    if (m.method === 'slash-command') {
      for (const c of e.evidence.commands) lines.push(`  command ${c.uuid} ${c.name} at ${c.ts_utc ?? '?'}`);
      for (const k of e.evidence.skills) lines.push(`  skill ${k.name} message ${k.message_id} at ${isoOf(k.ts_ms)}`);
      const omitted = e.totals.commands + e.totals.skills - e.evidence.commands.length - e.evidence.skills.length;
      if (omitted > 0) lines.push(`  instants_omitted=${omitted}`);
    }
  }
  return lines;
}

export const renderLinkEvidenceText = (e, opts) => `${renderLinkEvidenceLines(e, opts).join('\n')}\n`;
