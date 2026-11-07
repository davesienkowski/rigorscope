// Plan 03-01 (LEDG-02, D-02..D-04, D-06): the pure rules of ledger line format v1, no spawn. Written before the rules
// were completed (Task 2). The expectations are written by hand from the plan, never computed by the module under test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINE_FIELDS, MAX_LINE_BYTES, REJECT_REASONS, buildLine, validateLine,
} from '../../src/ledger/line.mjs';
import { QUICK_ID_RE, idShapeOk, unitKeyOf } from '../../src/units/unit-key.mjs';

const BASE = Object.freeze({
  record: 'start',
  ts: '2026-10-28T12:00:00.000Z',
  repo_key: '~/repos/alpha/.git',
  kind: 'quick',
  native_id: '261030-a1b',
  tier: 'A',
  tier_source: 'plan-at-start',
  start: '2026-10-28T12:00:00.000Z',
});
const build = (over = {}) => buildLine({ ...BASE, ...over });
const reasonOf = (over) => {
  const r = build(over);
  assert.equal(r.ok, false, JSON.stringify(over));
  return r.reason;
};

describe('allowlist: the frozen v1 field set (D-02)', () => {
  it('allowlist: buildLine output keys equal LINE_FIELDS in order and unknown fields are null', () => {
    const r = build();
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.line), [...LINE_FIELDS]);
    assert.deepEqual(Object.keys(JSON.parse(r.text)), [...LINE_FIELDS]);
    assert.deepEqual(LINE_FIELDS, [
      'v', 'record', 'line_id', 'ts', 'unit_key', 'framework', 'repo_key', 'kind', 'native_id', 'tier', 'tier_source',
      'command', 'runtime', 'session_id', 'model_hint', 'start', 'end', 'status', 'gsd_version',
    ]);
    for (const k of ['command', 'runtime', 'session_id', 'model_hint', 'end', 'status', 'gsd_version']) assert.equal(r.line[k], null, k);
    assert.equal(r.line.unit_key, 'gsd-core:~/repos/alpha/.git:quick:261030-a1b');
    assert.equal(r.line.framework, 'gsd-core');
  });

  it('allowlist: validateLine rejects any extra key, including branch, cwd, path and prompt, and a missing required field', () => {
    const ok = build().line;
    for (const k of ['branch', 'cwd', 'path', 'prompt', 'worktree', 'response']) {
      assert.deepEqual(validateLine({ ...ok, [k]: 'x' }), { ok: false, reason: 'unknown_field' }, k);
    }
    for (const k of ['v', 'record', 'line_id', 'ts', 'unit_key']) {
      const { [k]: _gone, ...rest } = ok;
      assert.deepEqual(validateLine(rest), { ok: false, reason: 'missing_field' }, k);
    }
    // an absent optional field reads as null
    const { command: _c, runtime: _r, ...fewer } = ok;
    assert.equal(validateLine(fewer).ok, true);
    assert.equal(validateLine(fewer).line.command, null);
    for (const bad of [null, 'x', [], 3]) assert.equal(validateLine(bad).reason, 'not_an_object');
  });

  it('allowlist: no input can add a key (extra fields passed to buildLine never reach the line)', () => {
    const r = buildLine({ ...BASE, branch: 'main', cwd: '/x', prompt: 'p', model_hint: 'opus' });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.line), [...LINE_FIELDS]);
    assert.equal(r.line.model_hint, null, 'model_hint is always null in v1');
    assert.ok(!r.text.includes('branch') && !r.text.includes('opus'));
  });
});

describe('id forms and the unit key (D-03)', () => {
  it('accepts 261030-a1b, 03-01, 02.1-01 and 100-01', () => {
    assert.equal(build({ native_id: '261030-a1b' }).ok, true);
    for (const id of ['03-01', '02.1-01', '100-01']) {
      const r = build({ kind: 'plan', native_id: id });
      assert.equal(r.ok, true, id);
      assert.equal(r.line.unit_key, `gsd-core:~/repos/alpha/.git:plan:${id}`);
    }
  });

  it('rejects slug-suffixed, uppercase, short, over-dotted, empty, padded and newline-bearing ids and a plan id with kind quick', () => {
    for (const id of ['261030-a1b-first-task', '261030-A1B', '2-01', '02.1.1-01', '', ' 261030-a1b', '261030-a1b ', '261030-a1b\n', '03-01']) {
      assert.equal(reasonOf({ kind: 'quick', native_id: id }), 'bad_id', JSON.stringify(id));
    }
    for (const id of ['02-1', '2-01', '02.1.1-01', '261030-a1b', '03-01\n']) {
      assert.equal(reasonOf({ kind: 'plan', native_id: id }), 'bad_id', JSON.stringify(id));
    }
    assert.equal(reasonOf({ kind: 'epic' }), 'bad_kind');
    assert.equal(reasonOf({ kind: undefined }), 'bad_kind');
    assert.equal(idShapeOk('quick', '261030-a1b'), true);
    assert.equal(QUICK_ID_RE.test('261030-a1b'), true);
  });

  it('validateLine rejects a unit_key that differs from unitKeyOf(repo_key, kind, native_id)', () => {
    const ok = build().line;
    assert.equal(unitKeyOf(ok.repo_key, ok.kind, ok.native_id), ok.unit_key);
    assert.equal(validateLine({ ...ok, unit_key: 'gsd-core:~/repos/beta/.git:quick:261030-a1b' }).reason, 'bad_unit_key');
    assert.equal(validateLine({ ...ok, framework: 'other' }).reason, 'bad_framework');
    assert.throws(() => unitKeyOf('', 'quick', '261030-a1b'), RangeError);
    assert.throws(() => unitKeyOf('~/x/.git', 'quick', '261030-a1b-slug'), RangeError);
  });

  it('a repo_key of 1024 characters is rejected as line_too_large, never truncated; one of 1025 is a bad repo key', () => {
    assert.equal(reasonOf({ repo_key: `~/${'a'.repeat(1022)}` }), 'line_too_large');
    assert.equal(reasonOf({ repo_key: `~/${'a'.repeat(1023)}` }), 'bad_repo_key');
    assert.equal(reasonOf({ repo_key: '' }), 'bad_repo_key');
    assert.equal(reasonOf({ repo_key: '~/café/.git' }), 'bad_repo_key');
    assert.equal(reasonOf({ repo_key: '~/a\n/.git' }), 'bad_repo_key');
  });
});

describe('tier and source (D-04)', () => {
  it('tier is null exactly when tier_source is unknown', () => {
    assert.equal(reasonOf({ tier: null, tier_source: 'plan-at-start' }), 'tier_source_mismatch');
    assert.equal(reasonOf({ tier: 'A', tier_source: 'unknown' }), 'tier_source_mismatch');
    const r = build({ tier: null, tier_source: 'unknown' });
    assert.equal(r.ok, true);
    assert.equal(r.line.tier, null);
  });

  it('per-record source sets: start takes declared-at-start, plan-at-start, unknown; close takes declared-at-close, unknown', () => {
    for (const s of ['declared-at-start', 'plan-at-start']) assert.equal(build({ tier_source: s }).ok, true, s);
    assert.equal(reasonOf({ tier_source: 'declared-at-close' }), 'bad_tier_source');
    assert.equal(reasonOf({ tier_source: 'guessed' }), 'bad_tier_source');
    assert.equal(reasonOf({ tier_source: null }), 'bad_tier_source');
    const close = { record: 'close', start: null, end: BASE.ts };
    assert.equal(buildLine({ ...BASE, ...close, tier_source: 'declared-at-close' }).ok, true);
    assert.equal(buildLine({ ...BASE, ...close, tier_source: 'plan-at-start' }).reason, 'bad_tier_source');
    assert.equal(buildLine({ ...BASE, ...close, tier_source: 'declared-at-start' }).reason, 'bad_tier_source');
  });

  it('lowercase or other tier letters are rejected', () => {
    for (const t of ['a', 'D', 'AA', '', 1]) assert.equal(reasonOf({ tier: t }), 'bad_tier', JSON.stringify(t));
  });
});

describe('field shapes and record rules', () => {
  it('start-only and close-only fields', () => {
    assert.equal(reasonOf({ end: BASE.ts }), 'wrong_record_field');
    assert.equal(reasonOf({ status: 'complete' }), 'wrong_record_field');
    const close = { record: 'close', tier: null, tier_source: 'unknown', start: null, end: BASE.ts };
    assert.equal(buildLine({ ...BASE, ...close, status: 'complete' }).ok, true);
    assert.equal(buildLine({ ...BASE, ...close, status: 'done' }).reason, 'bad_status');
    assert.equal(buildLine({ ...BASE, ...close, start: '2026-10-28T13:00:00.000Z' }).reason, 'end_before_start');
  });

  it('times: iso and real dates only', () => {
    for (const t of ['2026-10-28', '2026-10-28T12:00:00', '2026-02-30T12:00:00Z', 'yesterday', '2026-10-28T12:00:00+02:00']) {
      assert.equal(reasonOf({ start: t }), 'bad_start', t);
      assert.equal(reasonOf({ ts: t }), 'bad_ts', t);
    }
  });

  it('start and end later than the recorded ts are rejected (time_after_ts); equal to ts is accepted (review MEDIUM-1)', () => {
    const later = '2026-10-28T12:00:00.001Z';
    assert.equal(reasonOf({ start: later }), 'time_after_ts');
    const close = { record: 'close', tier: null, tier_source: 'unknown', start: null };
    assert.equal(buildLine({ ...BASE, ...close, end: later }).reason, 'time_after_ts');
    assert.equal(buildLine({ ...BASE, ...close, start: later, end: later }).reason, 'time_after_ts');
    assert.equal(buildLine({ ...BASE, ...close, start: '2030-01-01T00:00:00Z', end: '2030-01-01T00:00:01Z' }).reason, 'time_after_ts');
    // a close whose only late field is --start (end defaults to ts) is still rejected, as an end before its start
    assert.equal(buildLine({ ...BASE, ...close, start: later, end: BASE.ts }).reason, 'end_before_start');
    assert.equal(buildLine({ ...BASE, ...close, end: BASE.ts }).ok, true);
    assert.equal(build({ start: BASE.ts }).ok, true);
    // a reader sees the same rule
    const ok = build().line;
    assert.equal(validateLine({ ...ok, start: later }).reason, 'time_after_ts');
    // an end before its start still reports end_before_start first
    assert.equal(buildLine({ ...BASE, ...close, start: '2026-10-28T13:00:00.000Z', end: BASE.ts }).reason, 'end_before_start');
  });

  it('start and end are stored as one UTC form with milliseconds, so mixed input forms sort and compare right (review LOW-4)', () => {
    assert.equal(build({ start: '2026-10-28T11:00:00Z' }).line.start, '2026-10-28T11:00:00.000Z');
    assert.equal(build({ start: '2026-10-28T11:00:00.5Z' }).line.start, '2026-10-28T11:00:00.500Z');
    assert.equal(build({ start: '2026-10-28T11:00:00.123456789Z' }).line.start, '2026-10-28T11:00:00.123Z');
    const close = { record: 'close', tier: null, tier_source: 'unknown', start: null };
    assert.equal(buildLine({ ...BASE, ...close, end: '2026-10-28T11:30:00Z' }).line.end, '2026-10-28T11:30:00.000Z');
    // the id hashes the stored form: two spellings of one instant are one line
    assert.equal(build({ start: '2026-10-28T11:00:00Z' }).line.line_id, build({ start: '2026-10-28T11:00:00.000Z' }).line.line_id);
    // mixed spellings: the stored strings order the same as the instants
    const inputs = ['2026-10-28T11:00:00.500Z', '2026-10-28T11:00:00Z', '2026-10-28T11:00:00.25Z', '2026-10-28T10:59:59.999999Z'];
    const stored = inputs.map((t) => build({ start: t }).line.start);
    assert.deepEqual([...stored].sort(), [...stored].sort((a, b) => Date.parse(a) - Date.parse(b)));
    assert.deepEqual([...stored].sort(), [
      '2026-10-28T10:59:59.999Z', '2026-10-28T11:00:00.000Z', '2026-10-28T11:00:00.250Z', '2026-10-28T11:00:00.500Z',
    ]);
    // an invalid spelling is still rejected, not normalized into validity
    assert.equal(reasonOf({ start: '2026-02-30T12:00:00Z' }), 'bad_start');
  });

  it('command, runtime, session id and version shapes', () => {
    assert.equal(build({ command: 'gsd-quick', runtime: 'claude-code', session_id: 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1', gsd_version: '1.2.3' }).ok, true);
    assert.equal(build({ command: 'gsd:quick.v1_x' }).ok, true);
    assert.equal(reasonOf({ command: 'a b' }), 'bad_command');
    assert.equal(reasonOf({ command: '/gsd-quick' }), 'bad_command');
    assert.equal(reasonOf({ command: 'a'.repeat(65) }), 'bad_command');
    assert.equal(reasonOf({ runtime: 'Claude' }), 'bad_runtime');
    assert.equal(reasonOf({ runtime: '1abc' }), 'bad_runtime');
    assert.equal(reasonOf({ session_id: 'a b' }), 'bad_session_id');
    assert.equal(reasonOf({ session_id: 'a@b.invalid' }), 'bad_session_id');
    assert.equal(reasonOf({ gsd_version: 'v1' }), 'bad_version_string');
  });
});

describe('bytes and identity (D-01, D-06)', () => {
  it('exactly one LF, ASCII, no control or CR, at most 2048 bytes', () => {
    const r = build({ command: 'gsd-quick', runtime: 'claude-code' });
    assert.equal(r.ok, true);
    assert.equal(r.text.endsWith('\n'), true);
    assert.equal(r.text.indexOf('\n'), r.text.length - 1, 'one LF only, at the end');
    assert.ok(/^[\x20-\x7e]+\n$/.test(r.text));
    assert.ok(Buffer.byteLength(r.text) <= MAX_LINE_BYTES);
    assert.equal(MAX_LINE_BYTES, 2048);
    // a quote and a backslash in the repo key are escaped and stay on one line
    const q = build({ repo_key: '~/a"b\\c/.git' });
    assert.equal(q.ok, true);
    assert.equal(q.text.split('\n').length, 2);
    assert.equal(JSON.parse(q.text).repo_key, '~/a"b\\c/.git');
  });

  it('line_id is a 32-hex content hash: identical inputs repeat it, a changed field changes it', () => {
    const a = build().line.line_id;
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.equal(build().line.line_id, a);
    assert.notEqual(build({ native_id: '261029-c2d' }).line.line_id, a);
    assert.notEqual(build({ ts: '2026-10-28T12:00:01.000Z' }).line.line_id, a);
  });

  it('every reject reason has one fixed message and no message holds a value or a path', () => {
    for (const [code, msg] of Object.entries(REJECT_REASONS)) {
      assert.ok(typeof msg === 'string' && msg.length > 5, code);
      assert.ok(!msg.includes('/home') && !msg.includes('@'), code);
    }
  });
});
