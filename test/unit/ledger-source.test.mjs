// Plan 03-03 Task 2 (LEDG-03, D-12, J3, J12, R3): the ledger source's tolerant reader, tested on its functions with a fake
// ctx that collects tallies. The ingest-level cursor, partial-line, conflict, counter and doctor cases are in
// test/integration/ledger-ingest.test.mjs. Written before the code (RED).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ledger from '../../src/sources/ledger/index.mjs';
import { MAX_UNKNOWN_NAMES } from '../../src/sources/transcript/normalize.mjs';
import { buildLine, REJECT_REASONS } from '../../src/ledger/line.mjs';
import { validateDescriptor } from '../../src/ingest/sources.mjs';
import { PLANTS } from '../fixtures/build.mjs';

const REPO_KEY = '~/repos/alpha/.git';
const TS = '2026-10-28T12:00:00.000Z';
const good = (over = {}) => {
  const r = buildLine({
    record: 'start', ts: TS, repo_key: REPO_KEY, kind: 'quick', native_id: '261030-a1b', tier: 'A', tier_source: 'plan-at-start',
    start: TS, ...over,
  });
  assert.equal(r.ok, true, r.reason);
  return r.line;
};
const item = (text) => ({ buf: Buffer.from(text, 'utf8'), oversized: false, end: text.length + 1 });

function fakeCtx(home) {
  const t = { counter: {}, kinds: new Map(), attrs: [] };
  return {
    home,
    t,
    tally(kind, name, n = 1) {
      if (kind === 'counter') { t.counter[name] = (t.counter[name] ?? 0) + n; return; }
      const m = t.kinds.get(kind) ?? new Map();
      m.set(name, (m.get(name) ?? 0) + n);
      t.kinds.set(kind, m);
    },
    attr() {},
    options: {},
  };
}
const kind = (ctx, k) => Object.fromEntries(ctx.t.kinds.get(k) ?? []);

const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });
function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), 'rigorscope-ledger-src-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

describe('the ledger descriptor', () => {
  it('passes the loader contract; not live, so an idle ledger is never STALE', () => {
    validateDescriptor(ledger, 'ledger');
    assert.equal(ledger.name, 'ledger');
    assert.deepEqual(ledger.freshness, { live: false, staleAfterHours: 24 });
    assert.equal(ledger.cursorless, undefined, 'read through the cursor framework');
  });
});

describe('normalize: one outcome for every item (J12)', () => {
  const run = (text, ctx = fakeCtx('/nowhere')) => ({ ctx, res: ledger.normalize(item(text), {}, ctx) });

  it('a valid line is kept, mapped to the columns and tallied under lines/kept and counter kept', () => {
    const line = good({ command: 'gsd-quick', runtime: 'claude-code', session_id: 'sess-1' });
    const { ctx, res } = run(JSON.stringify(line));
    assert.equal(res.records.length, 1);
    const row = res.records[0].row;
    assert.equal(row.line_id, line.line_id);
    assert.equal(row.ts_utc, line.ts);
    assert.equal(row.start_utc, line.start);
    assert.equal(row.end_utc, null);
    assert.equal(row.command_name, 'gsd-quick');
    assert.match(row.line_sha, /^[0-9a-f]{64}$/);
    assert.equal(ctx.t.counter.kept, 1);
    assert.equal(ctx.t.counter.candidates, 1);
    assert.equal(ctx.t.counter.assistant_parsed, 1);
    assert.deepEqual(kind(ctx, 'lines'), { kept: 1 });
    assert.deepEqual(kind(ctx, 'dropped'), {});
  });

  it('a blank line is lines/blank only: not a candidate', () => {
    const { ctx, res } = run('');
    assert.deepEqual(res.records, []);
    assert.deepEqual(kind(ctx, 'lines'), { blank: 1 });
    assert.equal(ctx.t.counter.candidates ?? 0, 0);
  });

  it('an oversized item is counter oversized only', () => {
    const ctx = fakeCtx('/nowhere');
    const res = ledger.normalize({ oversized: true, head: Buffer.alloc(0), size: 9000, end: 9001 }, {}, ctx);
    assert.deepEqual(res.records, []);
    assert.equal(ctx.t.counter.oversized, 1);
    assert.equal(ctx.t.counter.candidates ?? 0, 0);
    assert.deepEqual(kind(ctx, 'dropped'), {});
  });

  it('not JSON counts once, as unparseable, and is never also a dropped row', () => {
    const { ctx, res } = run('{"v":1, nope');
    assert.deepEqual(res.records, []);
    assert.equal(ctx.t.counter.unparseable, 1);
    assert.equal(ctx.t.counter.candidates, 1);
    assert.deepEqual(kind(ctx, 'dropped'), {});
  });

  it('not a plain object and an unknown version are dropped under their names', () => {
    for (const [text, name] of [['[1,2]', 'not_object'], ['null', 'not_object'], ['"text"', 'not_object'], ['7', 'not_object'],
      ['{"v":2}', 'unknown_version'], ['{"v":"1"}', 'unknown_version'], ['{}', 'unknown_version']]) {
      const { ctx, res } = run(text);
      assert.deepEqual(res.records, [], text);
      assert.deepEqual(kind(ctx, 'dropped'), { [name]: 1 }, text);
      assert.equal(ctx.t.counter.unparseable ?? 0, 0, text);
    }
  });

  it('a REJECT_REASONS case is dropped under its code and stores nothing', () => {
    const cases = {
      bad_unit_key: { ...good(), unit_key: 'gsd-core:~/repos/alpha/.git:quick:261030-zzz' },
      bad_tier: { ...good(), tier: 'a' },
      bad_ts: { ...good(), ts: '2026-13-45T99:99:99.000Z' },
      bad_line_id: { ...good(), line_id: 'XYZ' },
      missing_field: (() => { const l = { ...good() }; delete l.unit_key; return l; })(),
    };
    for (const [code, obj] of Object.entries(cases)) {
      assert.ok(Object.hasOwn(REJECT_REASONS, code));
      const { ctx, res } = run(JSON.stringify(obj));
      assert.deepEqual(res.records, [], code);
      assert.deepEqual(kind(ctx, 'dropped'), { [code]: 1 }, code);
      assert.equal(ctx.t.counter.kept ?? 0, 0, code);
    }
  });

  it('a key outside the allowlist is removed and tallied by its shaped name; the line is still stored; the value is nowhere', () => {
    const line = { ...good(), branch: `feature/${PLANTS.email}`, 'a b': PLANTS.prompt, [PLANTS.email]: 'x' };
    const { ctx, res } = run(JSON.stringify(line));
    assert.equal(res.records.length, 1);
    assert.deepEqual(kind(ctx, 'rejected_field'), { branch: 1, '?': 2 });
    const blob = JSON.stringify([res.records, [...ctx.t.kinds], ctx.t.counter]);
    for (const plant of [PLANTS.email, PLANTS.prompt]) assert.ok(!blob.includes(plant), 'no plant in a record or a tally');
    assert.ok(!('branch' in res.records[0].row));
  });

  it('absent optional allowlisted keys read as null; a line missing a required key is dropped', () => {
    const text = JSON.stringify({
      v: 1, record: 'start', line_id: good().line_id, ts: TS, unit_key: good().unit_key, framework: 'gsd-core', repo_key: REPO_KEY,
      kind: 'quick', native_id: '261030-a1b', tier_source: 'unknown',
    });
    const { res } = run(text);
    assert.equal(res.records.length, 1);
    const row = res.records[0].row;
    for (const c of ['tier', 'command_name', 'runtime', 'session_id', 'model_hint', 'start_utc', 'end_utc', 'status', 'gsd_version']) {
      assert.equal(row[c], null, c);
    }
  });

  it('distinct unknown key names are capped per run; the rest fall into the question-mark bucket', () => {
    const ctx = fakeCtx('/nowhere');
    for (let i = 0; i < MAX_UNKNOWN_NAMES + 5; i += 1) {
      ledger.normalize(item(JSON.stringify({ ...good(), [`extra${i}`]: 1 })), {}, ctx);
    }
    const names = kind(ctx, 'rejected_field');
    assert.equal(Object.keys(names).filter((k) => k !== '?').length, MAX_UNKNOWN_NAMES);
    assert.equal(names['?'], 5);
  });

  it('times are stored in the canonical millisecond form', () => {
    const l = { ...good(), ts: '2026-10-28T12:00:00Z', start: '2026-10-28T11:59:59Z' };
    const { res } = run(JSON.stringify(l));
    assert.equal(res.records[0].row.ts_utc, '2026-10-28T12:00:00.000Z');
    assert.equal(res.records[0].row.start_utc, '2026-10-28T11:59:59.000Z');
  });
});

describe('discover: lstat only, symlinks skipped and counted', () => {
  const put = (home, text = 'x\n') => {
    mkdirSync(join(home, '.rigorscope', 'ledger'), { recursive: true });
    writeFileSync(join(home, '.rigorscope', 'ledger', 'units.jsonl'), text);
  };

  it('finds the one unit under root alias state; an absent directory or file gives no root', () => {
    const home = tmpHome();
    assert.deepEqual(ledger.discover(fakeCtx(home)), { roots: [], units: [] });
    mkdirSync(join(home, '.rigorscope', 'ledger'), { recursive: true });
    assert.deepEqual(ledger.discover(fakeCtx(home)), { roots: [], units: [] });
    put(home);
    const d = ledger.discover(fakeCtx(home));
    assert.deepEqual(d.roots, [{ alias: 'state', display: '~/.rigorscope/ledger', kind: 'ledger' }]);
    assert.equal(d.units.length, 1);
    assert.equal(d.units[0].rel, 'units.jsonl');
    assert.equal(d.units[0].rootAlias, 'state');
  });

  it('a symlinked directory and a symlinked file are skipped and counted', () => {
    const home = tmpHome();
    const other = join(home, 'elsewhere');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'units.jsonl'), 'x\n');
    mkdirSync(join(home, '.rigorscope'), { recursive: true });
    symlinkSync(other, join(home, '.rigorscope', 'ledger'));
    const ctx = fakeCtx(home);
    assert.deepEqual(ledger.discover(ctx), { roots: [], units: [] });
    assert.deepEqual(kind(ctx, 'walk_skip'), { symlink: 1 });

    const home2 = tmpHome();
    mkdirSync(join(home2, '.rigorscope', 'ledger'), { recursive: true });
    symlinkSync(join(other, 'units.jsonl'), join(home2, '.rigorscope', 'ledger', 'units.jsonl'));
    const ctx2 = fakeCtx(home2);
    assert.deepEqual(ledger.discover(ctx2), { roots: [], units: [] });
    assert.deepEqual(kind(ctx2, 'walk_skip'), { symlink: 1 });
  });
});
