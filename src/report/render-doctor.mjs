// Text and JSON renderers for the doctor report, and the signal listing (plan 01-09, TRUST-05, TRUST-09, RR-03).
// Imports only src/measure modules and built-ins (the renderer boundary). Every data-derived string is shape-checked
// again at print time and printed as ? when it fails; an unknown is ? (text) or null (JSON), never 0; a section that
// could not be read prints its key with `unavailable (reason)`.
import { formatAge, freshnessLines } from '../measure/freshness.mjs';
import { safeTokenOrUnknown } from '../measure/doctor.mjs';

export const DOCTOR_SCHEMA = 'rigorscope.doctor/1';
const VERDICTS = ['HEALTHY', 'UNVERIFIED', 'UNHEALTHY'];
const q = (v) => (v === null || v === undefined ? '?' : String(v));
const tok = (kind, v) => safeTokenOrUnknown(kind, typeof v === 'string' ? v : '');
const unavailable = (key, section) => `${key}: unavailable (${String(section.unavailable).replace(/[^\x20-\x7e]/g, '?').slice(0, 80)})`;

function storeLines(s) {
  if (!s.present) return ['store: absent (no ingest recorded; run rigorscope ingest)'];
  if (s.unavailable !== undefined) return [unavailable('store', s)];
  const last = s.last_run
    ? ` last_run=${q(s.last_run.id)} status=${tok('status', s.last_run.status)} ended=${q(s.last_run.ended_utc)} age=${formatAge(s.last_run.age_sec)}`
    : ' last_run=none';
  return [`store: schema=v${q(s.schema)} latest=v${q(s.latest)} pending=${q(s.pending)} runs=${q(s.runs)} ok=${q(s.ok)} failed=${q(s.failed)} other=${q(s.other)}${last}`];
}

function rootsLines(r) {
  const out = [`roots: transcript=${r.transcript.length} otel=${r.otel.length} skipped=${r.skipped.length} ignored=${r.ignored.length}`];
  for (const [label, list] of [['transcript', r.transcript], ['otel', r.otel]]) {
    for (const x of list) out.push(`  ${label} alias=${tok('source', x.alias)} kind=${tok('source', x.kind)} display=${tok('display', x.display)} files=${q(x.files)}`);
  }
  for (const x of r.skipped) out.push(`  skipped ${tok('display', x.name)} reason=${tok('error', x.reason)}`);
  for (const x of r.ignored) out.push(`  ignored ${tok('display', x)} (never read)`);
  for (const x of r.not_seen) out.push(`  not-seen ${tok('source', x.source)} alias=${tok('source', x.alias)} last_seen_run=${q(x.last_seen_run)}`);
  return out;
}

function cursorLines(c) {
  const out = [`cursors: sources=${c.sources.length}`];
  for (const x of c.sources) {
    out.push(`  ${tok('source', x.source)} alias=${tok('source', x.alias)} files=${q(x.files)} offset_bytes=${q(x.offset_bytes)} size_bytes=${q(x.size_bytes)} behind_files=${q(x.behind_files)} behind_bytes=${q(x.behind_bytes)} last_read_run=${q(x.last_read_run)}`);
  }
  for (const x of c.pending_tail) out.push(`  ${tok('source', x.source)} last_run_pending_tail_bytes=${q(x.bytes)}`);
  for (const x of c.cursorless) out.push(`  ${tok('source', x)} cursorless`);
  return out;
}

function unitNodeLine(n) {
  switch (n.status) {
    case 'ok': return `unit-node: ${tok('display', n.display)} ${tok('display', n.version)} floor=${tok('display', n.floor)} ok`;
    case 'not_found': return 'unit-node: not found on the unit PATH';
    case 'below_floor': return `unit-node: ${tok('display', n.version)} BELOW FLOOR ${tok('display', n.floor)}`;
    case 'no_sqlite': return `unit-node: ${tok('display', n.version)} LACKS node:sqlite (floor ${tok('display', n.floor)})`;
    default: return 'unit-node: unverified';
  }
}

export function renderDoctorText(report) {
  const out = [];
  const mark = report.clock_fixed ? ' (clock fixed by RIGORSCOPE_NOW)' : '';
  out.push(`doctor: ${VERDICTS.includes(report.verdict) ? report.verdict : '?'} as of ${report.as_of_utc}${mark}; problems=${report.counts.problems} leads=${report.counts.leads} unverified=${report.counts.unverified}`);
  for (const f of report.findings) out.push(`  ${f.cls} ${f.id}: ${f.text}`);
  out.push(...freshnessLines(report.freshnessCheck, { clockFixed: report.clock_fixed }));
  out.push(...storeLines(report.store));
  out.push(report.lock.present ? `lock: present age=${formatAge(report.lock.age_sec)}` : 'lock: absent');
  out.push(...rootsLines(report.roots));
  out.push(...(report.cursors.unavailable !== undefined ? [unavailable('cursors', report.cursors)] : cursorLines(report.cursors)));

  const ns = report.null_session_id;
  out.push(ns.unavailable !== undefined
    ? unavailable('null-session-id', ns)
    : `null-session-id: transcript_total=${q(ns.transcript.total)} transcript_last_run=${q(ns.transcript.last_run)} otel_total=${q(ns.otel.total)} otel_last_run=${q(ns.otel.last_run)}`);

  const ut = report.unknown_token_bearing;
  if (ut.unavailable !== undefined) out.push(unavailable('unknown-token-bearing', ut));
  else {
    out.push(`unknown-token-bearing: records=${q(ut.records)} names=${q(ut.names)} last_run=${q(ut.last_run)}`);
    for (const e of ut.entries) out.push(`  ${tok('source', e.source)} ${tok('token', e.name)} n=${q(e.n)}`);
  }

  const ua = report.unknown_attr;
  if (ua.unavailable !== undefined) out.push(unavailable('unknown-attr', ua));
  else {
    out.push(`unknown-attr: names=${q(ua.names)}`);
    for (const e of ua.entries) out.push(`  ${tok('source', e.source)} ${tok('scope', e.scope)} ${tok('attr', e.name)} last_run_n=${q(e.last_run_n)}`);
    if (ua.more > 0) out.push(`  ... and ${ua.more} more`);
  }

  const ll = report.ledger_lines;
  if (ll.unavailable !== undefined) out.push(unavailable('ledger-lines', ll));
  else {
    out.push(`ledger-lines: rows=${q(ll.rows)} kept=${q(ll.kept)} dropped=${q(ll.dropped)} bad_json=${q(ll.bad_json)} oversized=${q(ll.oversized)} `
      + `key_conflict=${q(ll.key_conflict)} unknown_keys=${q(ll.unknown_keys)} last_run_dropped=${q(ll.last_run_dropped)}`);
    for (const e of ll.dropped_by_reason) out.push(`  dropped ${tok('attr', e.name)} n=${q(e.n)}`);
    for (const e of ll.unknown_key_names) out.push(`  unknown-key ${tok('attr', e.name)} n=${q(e.n)}`);
  }

  const ul = report.unit_locations;
  if (ul.unavailable !== undefined) out.push(unavailable('unit-locations', ul));
  else {
    out.push(`unit-locations: repos=${q(ul.repos)} ${Object.entries(ul.totals).map(([k, n]) => `${tok('attr', k)}=${q(n)}`).join(' ')}`);
    for (const e of ul.per_repo) {
      out.push(`  repo ${tok('display', e.repo)} ${Object.entries(e.counts).map(([k, n]) => `${tok('attr', k)}=${q(n)}`).join(' ')}`);
    }
    if (ul.more > 0) out.push(`  ... and ${ul.more} more repos`);
  }

  const ro = report.roster;
  const dr = ro.drift;
  const driftText = dr.state === 'changed' ? `changed:${q(Array.isArray(dr.changed) ? dr.changed.length : null)}` : tok('attr', dr.state);
  const extra = dr.state === 'version_differs' || dr.state === 'same_version' ? ` installed=${tok('display', dr.installed_version)}`
    : (dr.state === 'unknown' ? ` reason=${tok('error', dr.reason)}` : '');
  out.push(`roster: ref=${tok('display', ro.ref)} version=${tok('display', ro.version)} entries=${q(ro.entries)} drift=${driftText}${extra}`);
  out.push('  the roster is a snapshot at that ref and is not proven complete; a changed or newer gsd-core can hold artifacts it does not know');
  out.push(`  not looked for by design: project_root_files=${q(ro.not_looked_for.root)} path_globs=${q(ro.not_looked_for.path_glob)}`);

  const uc = report.unclassified;
  if (uc.unavailable !== undefined) out.push(unavailable('unclassified', uc));
  else {
    out.push(`unclassified: files=${q(uc.files)} repos=${q(uc.repos)}${uc.unknown_repos > 0 ? ` unknown_repos=${q(uc.unknown_repos)}` : ''} not_in_roster_at_ref=${tok('display', uc.roster_ref)}`);
    if (uc.stems === null) out.push('  stems unknown (the latest scan run recorded none)');
    else {
      out.push(`  stems from the latest scan run, ${q(uc.stems_repos)} repos, files=${q(uc.stems_files)}`);
      for (const e of uc.stems) out.push(`  stem ${tok('attr', e.stem)} n=${q(e.n)}`);
      out.push(`  other n=${q(uc.other)}`);
    }
  }

  const jm = report.join_miss;
  if (jm.unavailable !== undefined) out.push(unavailable('join-miss', jm));
  else {
    out.push(`join-miss: otel_requests=${q(jm.otel_requests)} joined=${q(jm.joined)} sessions_no_transcript=${q(jm.sessions_no_transcript)} sessions_zero_joined=${q(jm.sessions_zero_joined)}`);
    if (jm.rates) for (const k of ['raw', 'joinable', 'excl_sdk']) out.push(`  ${k} miss=${jm.rates[k].text}`);
  }

  const an = report.agent_names;
  if (an.unavailable !== undefined) out.push(unavailable('agent-names', an));
  else {
    out.push(`agent-names: agree=${q(an.agree)} disagree=${q(an.disagree)} custom=${q(an.custom)} no_name=${q(an.no_name)} no_transcript_role=${q(an.no_transcript_role)} not_joined=${q(an.not_joined)} compared=${q(an.compared)}`);
    for (const p of an.pairs.slice(0, 5)) out.push(`  disagree transcript_role=${tok('attr', p.transcript_role)} otel_name=${tok('attr', p.otel_name)} n=${q(p.n)}`);
  }

  const us = report.usage;
  out.push(us.unavailable !== undefined
    ? unavailable('usage', us)
    : `usage: snapshots=${q(us.snapshots)} cache=${q(us.cache)} transcript=${q(us.transcript)} latest=${us.latest_utc ?? 'none'} age=${us.age_sec === null ? 'unavailable' : formatAge(us.age_sec)}`);

  const dc = report.discontinuity;
  if (dc.unavailable !== undefined) out.push(unavailable('discontinuity', dc));
  else if (!dc.checkable) out.push('discontinuity: none checkable');
  else {
    out.push(`discontinuity: five_hour=${q(dc.five_hour)} seven_day=${q(dc.seven_day)}`);
    for (const l of dc.lines) out.push(`  ${l.window} falling at ${l.at_utc} from ${l.from_pct} to ${l.to_pct}`);
    out.push('  note: a falling percentage without a reset can come from a different signed-in account or another machine; it is a lead, window shares across it render ?');
  }

  const t = report.timer;
  out.push(`timer: ${t.state} units=service:${t.units.service},timer:${t.units.timer} persistent=${q(t.persistent)} active=${q(t.active)} enabled=${q(t.enabled)} next=${q(t.next)} last=${q(t.last)}`);
  out.push(`service: result=${q(report.service.result)} exit_status=${q(report.service.exit_status)}`);
  out.push(unitNodeLine(report.unit_node));
  return `${out.join('\n')}\n`;
}

// Throws a RangeError on a non-finite number or an undefined value anywhere in the document.
function check(value) {
  if (value === undefined) throw new RangeError('doctor JSON holds an undefined value');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('doctor JSON holds a non-finite number');
  if (Array.isArray(value)) value.forEach(check);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(check);
}

export function renderDoctorJson(report) {
  const doc = {
    schema: DOCTOR_SCHEMA, as_of_utc: report.as_of_utc, clock_fixed: report.clock_fixed, verdict: report.verdict, counts: report.counts,
    findings: report.findings, freshness: report.freshness, store: report.store, lock: report.lock, roots: report.roots, cursors: report.cursors,
    null_session_id: report.null_session_id, unknown_token_bearing: report.unknown_token_bearing, unknown_attr: report.unknown_attr, ledger_lines: report.ledger_lines,
    unit_locations: report.unit_locations,
    roster: report.roster,
    unclassified: report.unclassified,
    join_miss: report.join_miss, agent_names: report.agent_names, usage: report.usage, discontinuity: report.discontinuity, timer: report.timer,
    service: report.service, unit_node: report.unit_node, derived: report.derived,
  };
  check(doc);
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function renderSignalsText(signals, consumers) {
  const out = [`signals: ${signals.length} registered`];
  for (const s of signals) {
    const surfaces = ['cost', 'doctor', 'units', 'tier'].filter((k) => Object.hasOwn(s.keys, k)).map((k) => `${k}=[${s.keys[k].join(', ')}]`);
    const consumer = Object.hasOwn(consumers, s.consumer) ? s.consumer : '?';
    out.push(`${s.id}: ${surfaces.join(' ')} consumer=${consumer} decision=${s.decision}`);
  }
  return `${out.join('\n')}\n`;
}
