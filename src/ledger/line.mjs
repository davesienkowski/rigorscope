// The forward ledger line, format v1 (plan 03-01, D-02, D-03, D-04; ADR-0010). One module holds the allowlist, the closed
// sets and the single rule set: buildLine assembles a line and runs validateLine on it, so the writer here and the ingest
// reader of plan 03-03 cannot disagree. Pure: no filesystem, no clock, no environment.
//
// A line holds only the fields of LINE_FIELDS, in that order, each unknown one null (never guessed). It never holds a
// branch name, a cwd or worktree path, a prompt, response or command text. The repo key is the home-normalized git common
// dir the reconstruction adapter uses, and the unit key is built by the same function (src/units/unit-key.mjs).
//
// Every rejection returns a code from REJECT_REASONS; each code has one fixed message that never holds a value, so a
// caller can print it without echoing an input, a path or a key.
import { createHash } from 'node:crypto';
import { checkShape } from '../redact/shapes.mjs';
import { canonicalJson } from '../env/snapshot.mjs';
import { FRAMEWORK, UNIT_KINDS, idShapeOk, unitKeyOf } from '../units/unit-key.mjs';

export const LEDGER_VERSION = 1;
export const LINE_FIELDS = Object.freeze([
  'v', 'record', 'line_id', 'ts', 'unit_key', 'framework', 'repo_key', 'kind', 'native_id', 'tier', 'tier_source',
  'command', 'runtime', 'session_id', 'model_hint', 'start', 'end', 'status', 'gsd_version',
]);
// The fields a line must carry to be read at all. Any other allowlisted field may be absent and then reads as null, but
// absent is not always valid: a line without kind, native_id, repo_key, framework or tier_source is still rejected below
// (bad_kind, bad_id, bad_repo_key, bad_framework, bad_tier_source), so only the optional fields (tier, command, runtime,
// session_id, model_hint, start, end, status, gsd_version) tolerate absence.
const REQUIRED = Object.freeze(['v', 'record', 'line_id', 'ts', 'unit_key']);
export const RECORDS = Object.freeze(['start', 'close']);
export const KINDS = UNIT_KINDS;
export const TIERS = Object.freeze(['A', 'B', 'C']);
export const TIER_SOURCES = Object.freeze(['declared-at-start', 'plan-at-start', 'declared-at-close', 'unknown']);
// The sources each record may carry (D-04).
export const SOURCES_BY_RECORD = Object.freeze({
  start: Object.freeze(['declared-at-start', 'plan-at-start', 'unknown']),
  close: Object.freeze(['declared-at-close', 'unknown']),
});
export const STATUSES = Object.freeze(['complete', 'failed', 'abandoned']);
export const MAX_LINE_BYTES = 2048;

export const REJECT_REASONS = Object.freeze({
  not_an_object: 'the ledger line is not an object',
  unknown_field: 'the ledger line has a field outside the allowlist',
  missing_field: 'the ledger line lacks a required field',
  bad_version: 'the ledger line version is not 1',
  bad_record: 'the record must be start or close',
  bad_line_id: 'the line id is malformed',
  bad_ts: 'the recorded time is not a UTC instant',
  bad_kind: '--kind must be quick or plan',
  bad_id: '--id is not a unit id of the kind (a quick id is YYMMDD-xxx, a plan id is NN-MM)',
  bad_repo_key: 'the repository key is not a printable ASCII path',
  bad_unit_key: 'the unit key does not match its parts',
  bad_framework: 'the framework is not gsd-core',
  bad_tier: '--tier must be A, B or C',
  bad_tier_source: '--tier-source is not allowed for this record',
  tier_source_mismatch: 'a tier needs a source other than unknown, and unknown needs no tier',
  plan_source_with_tier: '--tier cannot be combined with --tier-source plan-at-start',
  bad_command: '--command is not a command name',
  bad_runtime: '--runtime is not a runtime name',
  bad_session_id: '--session-id is not an id',
  bad_model_hint: 'the model hint must be null in format v1',
  bad_start: '--start is not a UTC instant',
  bad_end: '--end is not a UTC instant',
  bad_status: '--status must be complete, failed or abandoned',
  wrong_record_field: 'this field belongs to the other record',
  end_before_start: 'the end is before the start',
  time_after_ts: 'the start or end is later than the time the line was recorded',
  bad_version_string: 'the GSD version is malformed',
  line_too_large: 'the ledger line would exceed the size limit',
  not_a_repo: 'the working directory is not in a git repository',
  git_unavailable: 'git could not be run',
});

const COMMAND_RE = /^[A-Za-z0-9:_.-]{1,64}$/;
const RUNTIME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LINE_ID_RE = /^[0-9a-f]{32}$/;
const PRINTABLE_RE = /^[\x20-\x7e]{1,1024}$/;

const bad = (reason) => ({ ok: false, reason });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nullable = (v) => (v === undefined ? null : v);

// A UTC instant of the shared iso shape that is also a real date (2026-02-30 and a leap second are refused).
function isoOk(v) {
  if (checkShape('iso', v) === undefined) return false;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === v.slice(0, 19);
}

// A valid instant in the one stored form, UTC ISO with milliseconds (`...sssZ`), so stored text orders like the instants
// it names. Anything else is returned unchanged for validateLine to reject.
const canonicalIso = (v) => (typeof v === 'string' && isoOk(v) ? new Date(Date.parse(v)).toISOString() : nullable(v));

// The rules of format v1 on an object (a line parsed from the ledger, or the one buildLine just assembled).
// -> { ok: true, line } with every allowlisted field present (absent ones null), or { ok: false, reason }.
export function validateLine(input) {
  if (!isObject(input)) return bad('not_an_object');
  for (const k of Object.keys(input)) if (!LINE_FIELDS.includes(k)) return bad('unknown_field');
  for (const k of REQUIRED) if (!Object.hasOwn(input, k)) return bad('missing_field');
  const line = {};
  for (const k of LINE_FIELDS) line[k] = nullable(input[k]);

  if (line.v !== LEDGER_VERSION) return bad('bad_version');
  if (!RECORDS.includes(line.record)) return bad('bad_record');
  if (typeof line.line_id !== 'string' || !LINE_ID_RE.test(line.line_id)) return bad('bad_line_id');
  if (!isoOk(line.ts)) return bad('bad_ts');
  if (!KINDS.includes(line.kind)) return bad('bad_kind');
  if (!idShapeOk(line.kind, line.native_id)) return bad('bad_id');
  if (typeof line.repo_key !== 'string' || !PRINTABLE_RE.test(line.repo_key)) return bad('bad_repo_key');
  if (line.framework !== FRAMEWORK) return bad('bad_framework');
  if (typeof line.unit_key !== 'string' || !/^[\x20-\x7e]+$/.test(line.unit_key)
    || line.unit_key !== unitKeyOf(line.repo_key, line.kind, line.native_id)) return bad('bad_unit_key');

  if (line.tier !== null && !TIERS.includes(line.tier)) return bad('bad_tier');
  if (!SOURCES_BY_RECORD[line.record].includes(line.tier_source)) return bad('bad_tier_source');
  if ((line.tier === null) !== (line.tier_source === 'unknown')) return bad('tier_source_mismatch');

  if (line.command !== null && !(typeof line.command === 'string' && COMMAND_RE.test(line.command))) return bad('bad_command');
  if (line.runtime !== null && !(typeof line.runtime === 'string' && RUNTIME_RE.test(line.runtime))) return bad('bad_runtime');
  if (line.session_id !== null && checkShape('id', line.session_id) === undefined) return bad('bad_session_id');
  if (line.model_hint !== null) return bad('bad_model_hint');
  if (line.gsd_version !== null && checkShape('version', line.gsd_version) === undefined) return bad('bad_version_string');

  if (line.start !== null && !isoOk(line.start)) return bad('bad_start');
  if (line.end !== null && !isoOk(line.end)) return bad('bad_end');
  if (line.status !== null && !STATUSES.includes(line.status)) return bad('bad_status');
  if (line.record === 'start' && (line.end !== null || line.status !== null)) return bad('wrong_record_field');
  if (line.start !== null && line.end !== null && Date.parse(line.end) < Date.parse(line.start)) return bad('end_before_start');
  // An event cannot have happened after the line that records it (a wrong agent date must not enter a permanent record).
  const tsMs = Date.parse(line.ts);
  if ((line.start !== null && Date.parse(line.start) > tsMs) || (line.end !== null && Date.parse(line.end) > tsMs)) return bad('time_after_ts');
  return { ok: true, line };
}

// Assembles one line from the caller's fields (record, ts, repo_key, kind, native_id, tier, tier_source, command,
// runtime, session_id, start, end, status, gsd_version), validates it and serializes it with one LF.
// -> { ok: true, line, text } or { ok: false, reason }. Nothing is truncated: an oversized line is rejected.
export function buildLine(fields) {
  if (!isObject(fields)) return bad('not_an_object');
  const f = fields;
  if (!KINDS.includes(f.kind)) return bad('bad_kind');
  if (!idShapeOk(f.kind, f.native_id)) return bad('bad_id');
  if (typeof f.repo_key !== 'string' || !PRINTABLE_RE.test(f.repo_key)) return bad('bad_repo_key');
  const line = {
    v: LEDGER_VERSION,
    record: f.record,
    line_id: null,
    ts: f.ts,
    unit_key: unitKeyOf(f.repo_key, f.kind, f.native_id),
    framework: FRAMEWORK,
    repo_key: f.repo_key,
    kind: f.kind,
    native_id: f.native_id,
    tier: nullable(f.tier),
    tier_source: nullable(f.tier_source),
    command: nullable(f.command),
    runtime: nullable(f.runtime),
    session_id: nullable(f.session_id),
    model_hint: null,
    start: canonicalIso(f.start),
    end: canonicalIso(f.end),
    status: nullable(f.status),
    gsd_version: nullable(f.gsd_version),
  };
  // J5: a content hash, so identical calls under a fixed clock give the same id.
  const { line_id: _unused, ...rest } = line;
  line.line_id = createHash('sha256').update(canonicalJson(rest)).digest('hex').slice(0, 32);
  const checked = validateLine(line);
  if (!checked.ok) return checked;
  const text = `${JSON.stringify(checked.line)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) return bad('line_too_large');
  return { ok: true, line: checked.line, text };
}
