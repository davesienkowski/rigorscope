// Plan 01-09 contract: `rigorscope doctor` (TRUST-05, DATA-04, DATA-01, D-03, D-04, D-14, D-15). Written before the
// code (RED). Expected values are hand-computed below or read from the case modules' `expected` data, never from doctor
// output. The `loader` describe runs in process (loadDoctor with makeFakeRun); the `cli` describe spawns
// bin/rigorscope.mjs under cliEnv. Every case plants a fake node in the fixture HOME, because without one the unit PATH
// falls through to this machine's /usr/local/bin/node (v22) and the result would depend on the machine. New report
// fields are read defensively so a missing field fails an assertion and never throws. No planted value is printed in a
// failure message: output is scrubbed of the home path first.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  PLANTS, buildFixtureTree, cliEnv, ingestHome, makeHome, runCli, sha256File, windowsUsersDirFor,
} from '../fixtures/build.mjs';
import { FIXTURE_NOW } from '../fixtures/clock.mjs';
import { seedFreshness } from '../fixtures/freshness-rows.mjs';
import {
  homeDigest, installRepoUnits, linkCheckout, seedRun, seedSnapshot, seedSourceRoot, seedUnknownAttr, withStore,
  writeLockFile,
} from '../fixtures/doctor-rows.mjs';
import {
  NO_SYSTEMCTL, SYSTEMCTL_TIMEOUT, makeFakeRun, plantFakeNode, plantFakeSystemctl, readFakeLog,
} from '../fixtures/fake-bin.mjs';
import { SIGNALS } from '../../src/report/signals.mjs';
import { makeRepo } from '../fixtures/git-repo.mjs';
import { STOCK_LAYOUTS } from '../fixtures/stock-layouts.mjs';
import { LOCATION_KINDS } from '../../src/adapters/gsd-core/layout.mjs';
import { CACHE_FILE_NAME } from '../../src/sources/usage/cache.mjs';
import { acquireLock, releaseLock } from '../../src/ingest/lock.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const NOW = Date.parse(FIXTURE_NOW);
const iso = (ms) => new Date(ms).toISOString();
const get = (o, path) => path.split('.').reduce((a, k) => (a === null || a === undefined ? undefined : a[k]), o);
const ids = (r) => (r?.findings ?? []).map((f) => f.id);
const KEYS = [
  'freshness', 'store', 'lock', 'roots', 'cursors', 'null-session-id', 'unknown-token-bearing', 'unknown-attr',
  'join-miss', 'agent-names', 'usage', 'discontinuity', 'timer', 'service', 'unit-node',
];

// A fixture home with a planted fake node, the checkout symlink and the given cases ingested (none when cases is null).
async function fixture({ cases = null, ingest = true, units = false } = {}) {
  const ctx = makeHome();
  plantFakeNode(ctx.home);
  linkCheckout(ctx.home);
  if (cases) await buildFixtureTree(ctx.root, { home: ctx.home, cases });
  if (cases && ingest) await ingestHome(ctx.home);
  if (units) installRepoUnits(ctx.home);
  return ctx;
}
const using = async (opts, fn) => {
  const ctx = await fixture(opts);
  try {
    return await fn(ctx.home, ctx);
  } finally {
    ctx.cleanup();
  }
};

// In-process loader over a fake systemctl scenario and fake node table; a throw becomes data.
async function load(home, {
  scenario = 'active', version = 'v24.22.1\n', nodes, nowMs = NOW, fsOps, derive = true, systemdRunning = () => false,
} = {}) {
  const nodePath = join(home, '.local', 'bin', 'node');
  const run = makeFakeRun(scenario, nodes ?? { [nodePath]: { version } });
  try {
    if (derive && existsSync(join(home, '.rigorscope', 'store.db'))) {
      const { ensureDerived } = await mod('derive/ensure.mjs');
      ensureDerived({ home, now: () => new Date(nowMs) });
    }
    const { loadDoctor } = await mod('report/doctor.mjs');
    return (await loadDoctor({
      home, env: {}, nowMs, windowsUsersDir: windowsUsersDirFor(home), run, clockFixed: true, fsOps, systemdRunning,
    })) ?? {};
  } catch {
    return {};
  }
}

const scrub = (home, s) => String(s ?? '').split(home).join('<HOME>');
function doctor(home, args = [], extra = {}) {
  const r = runCli(['doctor', ...args], { home, env: cliEnv(home, extra) });
  const stdout = scrub(home, r.stdout);
  return { status: r.status, stdout, stderr: scrub(home, r.stderr), lines: stdout.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')) };
}
const topKeys = (lines) => lines.filter((l) => /^[a-z][a-z-]*:/.test(l)).map((l) => l.slice(0, l.indexOf(':')));
const lineOf = (lines, key) => lines.find((l) => l.startsWith(`${key}:`));
const sectionOf = (lines, key) => {
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at < 0) return [];
  let end = at + 1;
  while (end < lines.length && (lines[end].startsWith(' ') || lines[end] === '')) end += 1;
  return lines.slice(at, end);
};
const jsonOf = (r) => {
  try { return JSON.parse(r.stdout.split('<HOME>').join('')); } catch { return assert.fail('output is not one JSON document'); }
};
function fakePathFor(home, scenario) {
  const logPath = join(home, 'systemctl.log');
  const dir = plantFakeSystemctl(join(home, 'fakebin'), { scenario, logPath }).replace(/\/systemctl$/, '');
  return { FAKE_PATH: `${dir}:${process.env.PATH}`, logPath };
}

describe('doctor loader', () => {
  it('empty HOME: store absent, no_store problem, every section present, and nothing is created', () => using({}, async (home) => {
    const before = homeDigest(home);
    const r = await load(home);
    assert.equal(get(r, 'store.present'), false);
    assert.ok(ids(r).includes('no_store'));
    assert.equal(r.verdict, 'UNHEALTHY');
    assert.equal(existsSync(join(home, '.rigorscope')), false);
    assert.equal(homeDigest(home), before);
  }));

  // ---- (b) verdict table -----------------------------------------------------------------------------------------
  it('verdict: timer files missing give UNHEALTHY with the timer_missing problem', () => using({ cases: ['tracer-base'] }, async (home) => {
    const r = await load(home);
    assert.ok(ids(r).includes('timer_missing'));
    assert.equal(r.verdict, 'UNHEALTHY');
  }));

  it('verdict: no unit files and no systemctl binary give a not_configured lead, no timer problem and no unit-node problem', () => using({ cases: ['tracer-base'] }, async (home) => {
    const r = await load(home, { scenario: NO_SYSTEMCTL, nodes: {}, systemdRunning: () => true });
    assert.equal(get(r, 'timer.state'), 'not_configured');
    assert.ok(ids(r).includes('timer_not_configured'));
    assert.ok(!ids(r).includes('timer_missing'));
    assert.ok(!ids(r).includes('unit_node_missing'));
    assert.equal(get(r, 'counts.problems'), 0);
  }));

  it('verdict: no unit files, systemctl fails and systemd is not running give a not_configured lead', () => using({ cases: ['tracer-base'] }, async (home) => {
    const r = await load(home, { scenario: 'no-bus', systemdRunning: () => false });
    assert.equal(get(r, 'timer.state'), 'not_configured');
    assert.ok(ids(r).includes('timer_not_configured'));
    assert.ok(!ids(r).includes('timer_missing'));
  }));

  it('verdict: no unit files, systemctl fails but systemd IS running (no user bus) give timer_unverified and keep the unit-node check', () => using({ cases: ['tracer-base'] }, async (home) => {
    const nodePath = join(home, '.local', 'bin', 'node');
    const r = await load(home, { scenario: 'no-bus', systemdRunning: () => true, nodes: { [nodePath]: { version: 'v22.1.0\n' } } });
    assert.equal(get(r, 'timer.state'), 'unavailable');
    assert.ok(ids(r).includes('timer_unverified'));
    assert.ok(!ids(r).includes('timer_not_configured'));
    assert.ok(!ids(r).includes('timer_missing'));
    assert.ok(ids(r).includes('unit_node_below_floor'));
  }));

  it('verdict: no unit files, systemd running and a systemctl that times out give timer_unverified, not not_configured', () => using({ cases: ['tracer-base'] }, async (home) => {
    const nodePath = join(home, '.local', 'bin', 'node');
    const r = await load(home, { scenario: SYSTEMCTL_TIMEOUT, systemdRunning: () => true, nodes: { [nodePath]: { version: 'v22.1.0\n' } } });
    assert.equal(get(r, 'timer.state'), 'unavailable');
    assert.ok(ids(r).includes('timer_unverified'));
    assert.ok(!ids(r).includes('timer_not_configured'));
    assert.ok(ids(r).includes('unit_node_below_floor'));
  }));

  it('verdict: no unit files on a machine with a reachable systemd user manager keep timer_missing', () => using({ cases: ['tracer-base'] }, async (home) => {
    const r = await load(home, { scenario: 'active' });
    assert.equal(get(r, 'timer.state'), 'missing');
    assert.ok(ids(r).includes('timer_missing'));
  }));

  it('verdict: unit files present and no bus give UNVERIFIED with timer_unverified and no problem', () => using({ cases: ['tracer-base'], units: true }, async (home) => {
    const r = await load(home, { scenario: 'no-bus' });
    assert.equal(get(r, 'timer.state'), 'unavailable');
    assert.ok(ids(r).includes('timer_unverified'));
    assert.equal(get(r, 'counts.problems'), 0);
    assert.equal(r.verdict, 'UNVERIFIED');
  }));

  it('verdict: an active timer, fresh sources and a node at 24.22.1 give HEALTHY', () => using({ cases: ['tracer-base'], units: true }, async (home) => {
    const r = await load(home, { scenario: 'active' });
    assert.equal(get(r, 'timer.state'), 'active');
    assert.equal(get(r, 'counts.problems'), 0);
    assert.equal(get(r, 'counts.unverified'), 0);
    assert.equal(r.verdict, 'HEALTHY');
  }));

  it('verdict: a lead alone (unknown attribute names) leaves the verdict HEALTHY', () => using({ cases: ['hostile'], units: true }, async (home) => {
    const r = await load(home, { scenario: 'active' });
    assert.ok(ids(r).includes('unknown_attr'));
    assert.ok(get(r, 'counts.leads') > 0);
    assert.equal(r.verdict, 'HEALTHY');
  }));

  it('verdict: a problem and an unverified finding together give UNHEALTHY and both are counted', () => using({ cases: ['tracer-base'] }, async (home) => {
    const r = await load(home, { version: 'garbage\n' });
    assert.ok(ids(r).includes('timer_missing'));
    assert.ok(ids(r).includes('unit_node_unverified'));
    assert.equal(r.verdict, 'UNHEALTHY');
    assert.ok(get(r, 'counts.problems') >= 1 && get(r, 'counts.unverified') >= 1);
  }));

  // ---- (c) freshness boundary --------------------------------------------------------------------------------------
  // 36 h = 129600 s is not stale, 129601 s is. Arithmetic: NOW - 129600 s and NOW - 129601 s.
  const FRESH_ROWS = [
    ['newest record exactly 129600 s old is not stale', 129600, 60, false],
    ['newest record 129601 s old is stale', 129601, 60, true],
    ['last run exactly 129600 s old is not stale', 60, 129600, false],
    ['last run 129601 s old is stale', 60, 129601, true],
  ];
  for (const [title, recAge, runAge, stale] of FRESH_ROWS) {
    it(`freshness boundary: ${title}`, () => using({}, async (home) => {
      withStore(home, (db) => seedFreshness(db, {
        runs: [{ ended: iso(NOW - runAge * 1000), sources: ['transcript'], newest: iso(NOW - recAge * 1000) }],
        files: [{ source: 'transcript', alias: 'claude', rel: 'a.jsonl', last: iso(NOW - recAge * 1000) }],
      }));
      const r = await load(home);
      assert.ok((get(r, 'freshness.sources') ?? []).length > 0, 'the freshness section is present');
      const flagged = (r.findings ?? []).some((f) => f.id === 'source_stale' && String(f.text).includes('transcript'));
      assert.equal(flagged, stale);
    }));
  }

  it('freshness: a fresher preserve OTel file does not hide a stale live one', () => using({}, async (home) => {
    withStore(home, (db) => seedFreshness(db, {
      runs: [{ ended: iso(NOW - 60000), sources: ['transcript', 'otel'], newest: iso(NOW - 60000) }],
      files: [
        { source: 'otel', alias: 'live', rel: 'events-2026-10-26.jsonl', last: iso(NOW - 129601000) },
        { source: 'otel', alias: 'preserve', rel: 'events-2026-10-28.jsonl', last: iso(NOW - 60000) },
        { source: 'transcript', alias: 'claude', rel: 'a.jsonl', last: iso(NOW - 60000) },
      ],
    }));
    const r = await load(home);
    const otel = (get(r, 'freshness.sources') ?? []).find((s) => s.name === 'otel');
    assert.equal(otel?.state, 'stale');
    assert.ok((r.findings ?? []).some((f) => f.id === 'source_stale' && String(f.text).includes('otel')));
  }));

  // ---- (d) roots -------------------------------------------------------------------------------------------------
  it('roots: the transcript aliases, ignored backup directories, a skipped candidate and a not-seen stored root', () => using({ cases: ['subagents', 'backup-root'], ingest: false }, async (home) => {
    mkdirSync(join(home, '.claude', 'backups'), { recursive: true });
    mkdirSync(join(home, '.claude-backup'), { recursive: true });
    runCli(['ingest'], { home, env: cliEnv(home) });
    runCli(['ingest'], { home, env: cliEnv(home) });
    withStore(home, (db) => seedSourceRoot(db, { source: 'transcript', alias: 'ghost', display: '~/.ghost', lastSeenRun: 1 }));
    const r = await load(home);
    assert.deepEqual((get(r, 'roots.transcript') ?? []).map((x) => x.alias).slice(0, 2), ['claude', 'claude-contrib']);
    const ignored = get(r, 'roots.ignored') ?? [];
    assert.ok(ignored.includes('~/.claude/backups'), 'the backups directory under a root');
    assert.ok(ignored.includes('~/.claude-backup'), 'the Claude backup directory in HOME');
    assert.ok((get(r, 'roots.skipped') ?? []).length > 0, 'a skipped candidate with its reason');
    assert.deepEqual((get(r, 'roots.not_seen') ?? []).map((x) => x.alias), ['ghost']);
    assert.ok(ids(r).includes('root_not_seen'));
    const otelRoots = get(r, 'roots.otel') ?? [];
    assert.ok(Array.isArray(otelRoots));
  }));

  it('roots: a Windows root is listed through the Windows users directory', () => using({ ingest: false }, async (home) => {
    mkdirSync(join(windowsUsersDirFor(home), 'someone', '.claude', 'projects'), { recursive: true });
    const r = await load(home);
    assert.ok((get(r, 'roots.transcript') ?? []).some((x) => x.alias === 'win' && x.kind === 'windows'));
  }));

  it('roots: a root that was never ingested shows an unknown file count, not zero', () => using({ ingest: false }, async (home) => {
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    const r = await load(home);
    const claude = (get(r, 'roots.transcript') ?? []).find((x) => x.alias === 'claude');
    assert.ok(claude, 'the root is listed');
    assert.equal(claude.files, null);
  }));

  // ---- (e) cursors -----------------------------------------------------------------------------------------------
  it('cursors on case 10: offsets equal the on-disk sizes after a clean ingest, nothing is behind', () => using({ cases: ['tracer-base'] }, async (home, ctx) => {
    const sizes = readdirSync(join(ctx.root, 'projects'), { recursive: true })
      .filter((n) => String(n).endsWith('.jsonl')).map((n) => statSync(join(ctx.root, 'projects', String(n))).size);
    const r = await load(home);
    const row = (get(r, 'cursors.sources') ?? []).find((x) => x.source === 'transcript' && x.alias === 'claude');
    assert.equal(row?.files, 4, 'case 10 has four session files');
    assert.equal(row?.offset_bytes, sizes.reduce((a, b) => a + b, 0));
    assert.equal(row?.size_bytes, sizes.reduce((a, b) => a + b, 0));
    assert.equal(row?.behind_files, 0);
    assert.equal(row?.behind_bytes, 0);
    assert.ok(get(r, 'cursors.cursorless')?.includes('usage'));
  }));

  it('cursors: an appended unterminated 37-byte line shows behind_files=1 behind_bytes=37 and a pending tail of 37', () => using({ cases: ['tracer-base'] }, async (home, ctx) => {
    const file = readdirSync(join(ctx.root, 'projects'), { recursive: true }).map(String).find((n) => n.endsWith('sess-fixture-s1.jsonl'));
    appendFileSync(join(ctx.root, 'projects', file), 'x'.repeat(37));
    runCli(['ingest'], { home, env: cliEnv(home) });
    const r = await load(home);
    const row = (get(r, 'cursors.sources') ?? []).find((x) => x.source === 'transcript' && x.alias === 'claude');
    assert.equal(row?.behind_files, 1);
    assert.equal(row?.behind_bytes, 37);
    assert.equal((get(r, 'cursors.pending_tail') ?? []).find((x) => x.source === 'transcript')?.bytes, 37);
  }));

  // ---- (f) null session ids ----------------------------------------------------------------------------------------
  it('null session ids on case 50 after the first ingest: total 1, latest run 1', () => using({ cases: ['hostile'] }, async (home) => {
    const r = await load(home);
    assert.equal(get(r, 'null_session_id.transcript.total'), 1);
    assert.equal(get(r, 'null_session_id.transcript.last_run'), 1);
  }));

  it('null session ids on case 50 after a second ingest: the total stays 1, the latest run is 0', () => using({ cases: ['hostile'] }, async (home) => {
    runCli(['ingest'], { home, env: cliEnv(home) });
    const r = await load(home);
    assert.equal(get(r, 'null_session_id.transcript.total'), 1);
    assert.equal(get(r, 'null_session_id.transcript.last_run'), 0);
    assert.ok(ids(r).includes('null_session_id'));
  }));

  it('null session ids: a source with no run row is unknown (null), never 0', () => using({}, async (home) => {
    withStore(home, (db) => seedRun(db, { endedUtc: iso(NOW - 1000) }));
    const r = await load(home);
    assert.equal(get(r, 'null_session_id.transcript.total'), null);
    assert.equal(get(r, 'null_session_id.otel.last_run'), null);
  }));

  // ---- (g) unknown token-bearing and unknown attributes ------------------------------------------------------------
  it('unknown token-bearing on case 50: one record, one name, the mystery-usage entry', () => using({ cases: ['hostile'] }, async (home) => {
    const r = await load(home);
    assert.equal(get(r, 'unknown_token_bearing.records'), 1);
    assert.equal(get(r, 'unknown_token_bearing.names'), 1);
    assert.equal(get(r, 'unknown_token_bearing.last_run'), 1);
    assert.deepEqual((get(r, 'unknown_token_bearing.entries') ?? []).map((e) => `${e.source} ${e.name} ${e.n}`), ['transcript mystery-usage|2.9.9 1']);
    assert.ok(ids(r).includes('unknown_token_bearing'));
  }));

  it('unknown-attr on case 50 lists the four expected names in source, scope, name byte order', () => using({ cases: ['hostile'] }, async (home) => {
    // Case expected.unknownAttr: line|?, line|brandNewLineField, message|brandNewMsgField, usage|brand_new_usage_field.
    const r = await load(home);
    assert.equal(get(r, 'unknown_attr.names'), 4);
    assert.deepEqual((get(r, 'unknown_attr.entries') ?? []).map((e) => `${e.scope}|${e.name}`), [
      'line|?', 'line|brandNewLineField', 'message|brandNewMsgField', 'usage|brand_new_usage_field',
    ]);
  }));

  it('unknown-attr is capped at 40 listed names and counts the remainder (45 seeded names give 40 and 5 more)', () => using({}, async (home) => {
    withStore(home, (db) => {
      const run = seedRun(db, { endedUtc: iso(NOW - 1000) });
      for (let i = 0; i < 45; i += 1) seedUnknownAttr(db, { source: 'transcript', scope: 'line', name: `field${String(i).padStart(2, '0')}`, runId: run });
    });
    const r = await load(home);
    assert.equal(get(r, 'unknown_attr.names'), 45);
    assert.equal((get(r, 'unknown_attr.entries') ?? []).length, 40);
    assert.equal(get(r, 'unknown_attr.more'), 5);
  }));

  it('unknown-attr: a stored name that fails the shape check is returned as ?', () => using({}, async (home) => {
    withStore(home, (db) => {
      const run = seedRun(db, { endedUtc: iso(NOW - 1000) });
      seedUnknownAttr(db, { source: 'transcript', scope: 'line', name: 'bad name; rm -rf', runId: run });
    });
    const r = await load(home);
    assert.deepEqual((get(r, 'unknown_attr.entries') ?? []).map((e) => e.name), ['?']);
  }));

  // ---- (h) join-miss -----------------------------------------------------------------------------------------------
  it('join-miss on the otel-join case: raw 9/15, joinable 7/13, excl_sdk 5/10 with the session counts', () => using({ cases: ['otel-join'] }, async (home) => {
    // Hits (cost footer): raw 6/15, joinable 6/13, excl_sdk 5/10. Misses are denominator minus hits:
    //   raw 15 - 6 = 9 of 15 = 60.00%; joinable 13 - 6 = 7 of 13 = 5385 bp = 53.85%; excl_sdk 10 - 5 = 5 of 10 = 50.00%.
    const r = await load(home);
    const m = r.join_miss ?? {};
    assert.equal(m.otel_requests, 15);
    assert.equal(m.joined, 6);
    assert.equal(m.sessions_no_transcript, 3);
    assert.equal(m.sessions_zero_joined, 4);
    assert.equal(m.rates?.raw?.text, '9/15 (60.00%)');
    assert.equal(m.rates?.joinable?.text, '7/13 (53.85%)');
    assert.equal(m.rates?.joinable?.bp, 5385);
    assert.equal(m.rates?.excl_sdk?.text, '5/10 (50.00%)');
  }));

  it('join-miss on a HOME with no OTel requests has no rate', () => using({ cases: ['tracer-base'] }, async (home) => {
    const r = await load(home);
    assert.equal(get(r, 'join_miss.otel_requests'), 0);
    assert.equal(get(r, 'join_miss.rates'), null);
  }));

  // ---- (j) usage and discontinuity ---------------------------------------------------------------------------------
  const D = Date.parse('2026-10-28T00:00:00.000Z');
  const at = (h) => D + h * 3600000;
  const R5 = Date.parse('2026-10-28T15:00:00.000Z');
  const R5B = Date.parse('2026-10-28T20:00:00.000Z');
  const R7 = Date.parse('2026-10-31T00:00:00.000Z');
  const snap = (h, five, seven, reset5 = R5) => ({
    source: 'claude-json-cache', fetchedAtMs: at(h),
    five_hour: five === null ? null : { pct: five, resetsMs: reset5 },
    seven_day: seven === null ? null : { pct: seven, resetsMs: R7 },
  });
  it('discontinuity: five_hour falls once (55 to 20) and seven_day falls once (30 to 29); a flat pair and a reset are not counted', () => using({}, async (home) => {
    // five_hour: 09:00 40, 10:00 55 (rise), 11:00 20 (falling), 12:00 20 (flat), 13:00 5 with a new reset (reset).
    // seven_day: 10:00 30, 11:00 29 (falling).
    withStore(home, (db) => {
      seedRun(db, { endedUtc: iso(NOW - 1000) });
      for (const s of [snap(9, 40, null), snap(10, 55, 30), snap(11, 20, 29), snap(12, 20, null), snap(13, 5, null, R5B)]) seedSnapshot(db, s);
    });
    const r = await load(home);
    assert.equal(get(r, 'discontinuity.five_hour'), 1);
    assert.equal(get(r, 'discontinuity.seven_day'), 1);
    const lines = (get(r, 'discontinuity.lines') ?? []).map((l) => `${l.window} falling at ${l.at_utc} from ${l.from_pct} to ${l.to_pct}`);
    assert.deepEqual(lines, [
      'five_hour falling at 2026-10-28T11:00:00.000Z from 55.00% to 20.00%',
      'seven_day falling at 2026-10-28T11:00:00.000Z from 30.00% to 29.00%',
    ]);
    assert.ok(ids(r).includes('usage_discontinuity'));
  }));

  it('discontinuity: a single snapshot is not checkable and zero snapshots give an unknown age', () => using({}, async (home) => {
    withStore(home, (db) => { seedRun(db, { endedUtc: iso(NOW - 1000) }); seedSnapshot(db, snap(10, 55, 30)); });
    const one = await load(home);
    assert.equal(get(one, 'discontinuity.checkable'), false);
    assert.equal(get(one, 'usage.snapshots'), 1);
  }));

  it('usage with zero snapshots has snapshots 0 and a null age, never 0 seconds', () => using({}, async (home) => {
    withStore(home, (db) => seedRun(db, { endedUtc: iso(NOW - 1000) }));
    const r = await load(home);
    assert.equal(get(r, 'usage.snapshots'), 0);
    assert.equal(get(r, 'usage.age_sec'), null);
    assert.ok(!ids(r).includes('snapshot_old'));
  }));

  // 7 days = 604800 s is not old; 604801 s is. The limit is the usage source's staleAfterHours (168) times 3600.
  for (const [age, old] of [[604800, false], [604801, true]]) {
    it(`snapshot age ${age} s ${old ? 'raises' : 'does not raise'} snapshot_old`, () => using({}, async (home) => {
      withStore(home, (db) => { seedRun(db, { endedUtc: iso(NOW - 1000) }); seedSnapshot(db, { source: 'claude-json-cache', fetchedAtMs: NOW - age * 1000, five_hour: null, seven_day: null }); });
      const r = await load(home);
      assert.equal(get(r, 'usage.age_sec'), age);
      assert.equal(ids(r).includes('snapshot_old'), old);
    }));
  }

  // ---- (k) timer, service, unit node -------------------------------------------------------------------------------
  const TIMER_ROWS = [
    ['active', 'active', null], ['inactive', 'inactive', 'timer_inactive'], ['not-enabled', 'not_enabled', 'timer_not_enabled'],
    ['not-found', 'missing', 'timer_missing'], ['masked', 'missing', 'timer_missing'], ['no-bus', 'unavailable', 'timer_unverified'],
  ];
  for (const [scenario, state, finding] of TIMER_ROWS) {
    it(`timer scenario ${scenario}: state ${state}${finding ? ` and finding ${finding}` : ' and no timer finding'}`, () => using({ cases: ['tracer-base'], units: true }, async (home) => {
      const r = await load(home, { scenario });
      assert.equal(get(r, 'timer.state'), state);
      if (finding) assert.ok(ids(r).includes(finding));
      else assert.ok(!ids(r).some((i) => i.startsWith('timer_')));
    }));
  }

  it('service scenario service-failed adds the service_failed problem with the exit status', () => using({ cases: ['tracer-base'], units: true }, async (home) => {
    const r = await load(home, { scenario: 'service-failed' });
    assert.ok(ids(r).includes('service_failed'));
    assert.equal(get(r, 'service.exit_status'), 1);
    assert.equal(get(r, 'service.result'), 'exit-code');
  }));

  it('installed unit text that differs from the repo text raises the unit_drift lead', () => using({ cases: ['tracer-base'] }, async (home) => {
    installRepoUnits(home, { timer: '[Timer]\nOnCalendar=daily\n' });
    const r = await load(home, { scenario: 'active' });
    assert.ok(ids(r).includes('unit_drift'));
    assert.equal(get(r, 'timer.units.timer'), 'differs');
    assert.equal(get(r, 'timer.units.service'), 'same');
  }));

  const NODE_ROWS = [
    ['v24.22.1 is ok', { version: 'v24.22.1\n' }, undefined, 'ok', null],
    ['v24.14.9 is below the floor', { version: 'v24.14.9\n' }, undefined, 'below_floor', 'unit_node_below_floor'],
    ['v22.22.3 is below the floor', { version: 'v22.22.3\n' }, undefined, 'below_floor', 'unit_node_below_floor'],
    ['an absent node is not found', { version: 'v24.22.1\n' }, { statSync: () => undefined, accessSync: () => { throw new Error('no'); } }, 'not_found', 'unit_node_missing'],
    ['a node whose probe times out is unusable', { timeout: true }, undefined, 'unusable', 'unit_node_unverified'],
  ];
  for (const [title, entry, fsOps, status, finding] of NODE_ROWS) {
    it(`unit-node: ${title}`, () => using({ cases: ['tracer-base'], units: true }, async (home) => {
      const nodePath = join(home, '.local', 'bin', 'node');
      const r = await load(home, { nodes: { [nodePath]: entry }, fsOps });
      assert.equal(get(r, 'unit_node.status'), status);
      if (finding) assert.ok(ids(r).includes(finding));
      else assert.ok(!ids(r).some((i) => i.startsWith('unit_node_')));
    }));
  }

  // ---- (l) lock ----------------------------------------------------------------------------------------------------
  // INGEST_TIMEOUT_HOURS 6 x 3600 = 21600 s: exactly that age is not old, one second more is.
  for (const [age, old, title] of [[21600, false, 'at exactly 21600 s is not old'], [21601, true, 'at 21601 s is old'], [-5, false, 'dated 5 s in the future prints a negative age and raises nothing']]) {
    it(`lock ${title}`, () => using({}, async (home) => {
      withStore(home, (db) => seedRun(db, { endedUtc: iso(NOW - 1000) }));
      writeLockFile(home, NOW - age * 1000);
      const r = await load(home);
      assert.equal(get(r, 'lock.present'), true);
      assert.equal(get(r, 'lock.age_sec'), age);
      assert.equal(ids(r).includes('lock_old'), old);
    }));
  }

  it('lock absent: present false and a null age', () => using({}, async (home) => {
    withStore(home, (db) => seedRun(db, { endedUtc: iso(NOW - 1000) }));
    const r = await load(home);
    assert.equal(get(r, 'lock.present'), false);
    assert.equal(get(r, 'lock.age_sec'), null);
  }));

  it('loader is read-only: it takes no lock and changes no byte of store.db or derived.db', () => using({ cases: ['tracer-base'] }, async (home) => {
    assert.equal(get(await load(home), 'store.present'), true);
    const dir = join(home, '.rigorscope');
    const before = ['store.db', 'derived.db'].map((n) => sha256File(join(dir, n)));
    await load(home);
    assert.deepEqual(['store.db', 'derived.db'].map((n) => sha256File(join(dir, n))), before);
    assert.equal(existsSync(join(dir, 'ingest.lock')), false, 'no lock file');
  }));
});

describe('doctor cli', () => {
  it('empty HOME: exit 0, the verdict line, store: absent, the 15 keys in the fixed order, and no .rigorscope directory', () => using({}, (home) => {
    const r = doctor(home);
    assert.equal(r.status, 0);
    assert.ok(r.lines[0]?.startsWith('doctor: UNHEALTHY as of 2026-10-28T12:00:00.000Z (clock fixed by RIGORSCOPE_NOW); problems='));
    assert.equal(lineOf(r.lines, 'store'), 'store: absent (no ingest recorded; run rigorscope ingest)');
    assert.ok(r.lines.some((l) => l.startsWith('  problem no_store: ')));
    assert.deepEqual(topKeys(r.lines).filter((k) => KEYS.includes(k)), KEYS);
    assert.equal(existsSync(join(home, '.rigorscope')), false);
  }));

  it('grammar on a rich HOME: every section line has its fixed form', () => using({ cases: 'all', units: true }, (home) => {
    const r = doctor(home);
    assert.equal(r.status, 0);
    const want = [
      ['store', /^store: schema=v\d+ latest=v\d+ pending=\d+ runs=\d+ ok=\d+ failed=\d+ other=\d+ last_run=\d+ status=[a-z-]+ ended=\S+ age=-?\d+h\d{2}m\d{2}s$/],
      ['lock', /^lock: (absent|present age=-?\d+h\d{2}m\d{2}s)$/],
      ['roots', /^roots: transcript=\d+ otel=\d+ skipped=\d+ ignored=\d+$/],
      ['cursors', /^cursors: sources=\d+$/],
      ['null-session-id', /^null-session-id: transcript_total=\S+ transcript_last_run=\S+ otel_total=\S+ otel_last_run=\S+$/],
      ['unknown-token-bearing', /^unknown-token-bearing: records=\d+ names=\d+ last_run=\d+$/],
      ['unknown-attr', /^unknown-attr: names=\d+$/],
      ['join-miss', /^join-miss: otel_requests=\d+ joined=\d+ sessions_no_transcript=\d+ sessions_zero_joined=\d+$/],
      ['agent-names', /^agent-names: agree=\d+ disagree=\d+ custom=\d+ no_name=\d+ no_transcript_role=\d+ not_joined=\d+ compared=\d+$/],
      ['usage', /^usage: snapshots=\d+ cache=\d+ transcript=\d+ latest=\S+ age=\S+$/],
      ['discontinuity', /^discontinuity: (five_hour=\d+ seven_day=\d+|none checkable)$/],
      ['timer', /^timer: (missing|not_configured|unavailable|inactive|not_enabled|active) units=service:(absent|same|differs),timer:(absent|same|differs) persistent=\S+ active=\S+ enabled=\S+ next=.+ last=.+$/],
      ['service', /^service: result=\S+ exit_status=\S+$/],
      ['unit-node', /^unit-node: (~\/\.local\/bin\/node v\d+\.\d+\.\d+ floor=24\.15\.0 ok|.+)$/],
    ];
    for (const [key, re] of want) assert.match(lineOf(r.lines, key) ?? '', re, `${key} line`);
    assert.match(r.lines[0], /^doctor: (HEALTHY|UNVERIFIED|UNHEALTHY) as of \S+ \(clock fixed by RIGORSCOPE_NOW\); problems=\d+ leads=\d+ unverified=\d+$/);
  }));

  it('finding lines are indented two spaces, ordered problems then unverified then leads', () => using({ cases: ['hostile'], units: true }, (home) => {
    const r = doctor(home);
    const findings = r.lines.filter((l) => /^ {2}(problem|unverified|lead) /.test(l));
    assert.ok(findings.length > 0);
    const rank = { problem: 0, unverified: 1, lead: 2 };
    const ranks = findings.map((l) => rank[l.trim().split(' ')[0]]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  }));

  it('the freshness block of doctor equals the freshness block of cost for the same HOME and clock', () => using({ cases: ['tracer-base'] }, (home) => {
    const cost = runCli(['cost'], { home, env: cliEnv(home) });
    const costLines = scrub(home, cost.stdout).split('\n');
    const costBlock = costLines.slice(0, costLines.findIndex((l) => l.startsWith('period:')));
    const r = doctor(home);
    assert.deepEqual(sectionOf(r.lines, 'freshness'), costBlock);
  }));

  it('agent-names numbers equal the crosscheck footer of cost for the same HOME', () => using({ cases: ['otel-join'] }, (home) => {
    const cost = scrub(home, runCli(['cost'], { home, env: cliEnv(home) }).stdout).split('\n');
    const foot = Object.fromEntries((lineOf(cost, 'crosscheck') ?? '').replace('crosscheck: ', '').split(' ').map((kv) => kv.split('=')));
    const an = lineOf(doctor(home).lines, 'agent-names') ?? '';
    for (const k of ['agree', 'disagree', 'custom', 'no_name', 'no_transcript_role', 'not_joined', 'compared']) {
      assert.ok(an.includes(`${k}=${foot[k]}`), `agent-names ${k}`);
    }
  }));

  it('join-miss lines on the otel-join case', () => using({ cases: ['otel-join'] }, (home) => {
    const lines = sectionOf(doctor(home).lines, 'join-miss');
    assert.equal(lines[0], 'join-miss: otel_requests=15 joined=6 sessions_no_transcript=3 sessions_zero_joined=4');
    assert.ok(lines.includes('  raw miss=9/15 (60.00%)'));
    assert.ok(lines.includes('  joinable miss=7/13 (53.85%)'));
    assert.ok(lines.includes('  excl_sdk miss=5/10 (50.00%)'));
  }));

  it('a HOME with no OTel requests prints join-miss: otel_requests=0 and no rate lines', () => using({ cases: ['tracer-base'] }, (home) => {
    const lines = sectionOf(doctor(home).lines, 'join-miss');
    assert.ok(String(lines[0]).startsWith('join-miss: otel_requests=0'));
    assert.equal(lines.length, 1);
  }));

  it('a stored unknown-attr name that fails the shape check prints as ?', () => using({}, (home) => {
    withStore(home, (db) => {
      const run = seedRun(db, { endedUtc: iso(NOW - 1000) });
      seedUnknownAttr(db, { source: 'transcript', scope: 'line', name: 'bad name; rm -rf', runId: run });
    });
    const lines = sectionOf(doctor(home).lines, 'unknown-attr');
    assert.deepEqual(lines, ['unknown-attr: names=1', '  transcript line ? last_run_n=1']);
  }));

  it('unknown token-bearing records are listed on case 50 and never abort', () => using({ cases: ['hostile'] }, (home) => {
    const r = doctor(home);
    assert.equal(r.status, 0);
    assert.deepEqual(sectionOf(r.lines, 'unknown-token-bearing'), [
      'unknown-token-bearing: records=1 names=1 last_run=1', '  transcript mystery-usage|2.9.9 n=1',
    ]);
  }));

  it('lock held by another process: ingest skips with exit 0 and doctor shows the lock present, then absent after release', () => using({ cases: ['tracer-base'] }, (home) => {
    const live = new Date().toISOString();
    const got = acquireLock({ home });
    try {
      assert.equal(got.acquired, true);
      const ing = runCli(['ingest'], { home, env: cliEnv(home, { RIGORSCOPE_NOW: live }) });
      assert.equal(ing.status, 0);
      assert.match(ing.stdout, /^ingest: skipped, another ingest holds the lock/);
      assert.match(lineOf(doctor(home, [], { RIGORSCOPE_NOW: live }).lines, 'lock') ?? '', /^lock: present age=/);
    } finally {
      releaseLock(got.handle);
    }
    assert.equal(lineOf(doctor(home).lines, 'lock'), 'lock: absent');
  }));

  it('running doctor twice changes no byte of store.db or derived.db and adds only -wal and -shm sidecars', () => using({ cases: ['tracer-base'] }, (home) => {
    const dir = join(home, '.rigorscope');
    assert.equal(doctor(home).status, 0);
    const names = readdirSync(dir).sort();
    const sums = ['store.db', 'derived.db'].map((n) => sha256File(join(dir, n)));
    assert.equal(doctor(home).status, 0);
    assert.deepEqual(['store.db', 'derived.db'].map((n) => sha256File(join(dir, n))), sums);
    const extra = readdirSync(dir).filter((n) => !names.includes(n));
    assert.deepEqual(extra.filter((n) => !/^store\.db-(wal|shm)$/.test(n)), []);
  }));

  it('doctor while another connection holds an open uncommitted write prints the committed state and exits 0', () => using({ cases: ['tracer-base'] }, async (home) => {
    const { openStore } = await mod('db.mjs');
    const committed = Number(/runs=(\d+)/.exec(lineOf(doctor(home).lines, 'store') ?? '')?.[1]);
    const db = openStore({ home });
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec("INSERT INTO ingest_run (started_utc, trigger) VALUES ('2026-10-28T11:59:00.000Z', 'test')");
      const r = doctor(home);
      assert.equal(r.status, 0);
      assert.equal(Number(/runs=(\d+)/.exec(lineOf(r.lines, 'store') ?? '')?.[1]), committed);
    } finally {
      try { db.exec('ROLLBACK'); } catch { /* closed */ }
      db.close();
    }
    assert.ok(Number.isInteger(committed) && committed >= 1);
  }));

  it('doctor exits 0 with problems present, and exits 2 for a stray word or an unknown flag before any state is created', () => using({}, (home) => {
    assert.equal(doctor(home).status, 0);
    for (const args of [['extra'], ['--bogus']]) {
      const r = doctor(home, args);
      assert.equal(r.status, 2, 'usage error exit status');
    }
    assert.equal(doctor(home, ['--json', '--signals']).status, 2);
    assert.equal(existsSync(join(home, '.rigorscope')), false);
  }));

  it('--json prints one document of schema rigorscope.doctor/1 and nothing on stderr; its verdict, counts and join numbers equal the text', () => using({ cases: ['otel-join'], units: true }, (home) => {
    const text = doctor(home);
    const json = doctor(home, ['--json']);
    assert.equal(json.status, 0);
    assert.equal(json.stderr, '');
    const doc = jsonOf(json);
    assert.equal(doc.schema, 'rigorscope.doctor/1');
    assert.equal(text.lines[0].split(' ')[1], doc.verdict);
    assert.ok(text.lines[0].endsWith(`problems=${doc.counts?.problems} leads=${doc.counts?.leads} unverified=${doc.counts?.unverified}`));
    assert.equal(doc.join_miss?.otel_requests, 15);
    assert.equal(doc.join_miss?.rates?.raw?.text, '9/15 (60.00%)');
    assert.ok(!/NaN|Infinity/.test(json.stdout));
  }));

  it('--json on an empty HOME holds unknowns as null, not 0', () => using({}, (home) => {
    const doc = jsonOf(doctor(home, ['--json']));
    assert.equal(doc.store?.present, false);
    assert.equal(doc.usage?.age_sec ?? null, null);
    assert.equal(doc.lock?.age_sec ?? null, null);
  }));

  it('--signals reads no state: on an empty HOME it exits 0, creates nothing, and prints the registry in order, byte-identical twice', () => using({}, (home) => {
    const a = doctor(home, ['--signals']);
    const b = doctor(home, ['--signals']);
    assert.equal(a.status, 0);
    assert.equal(existsSync(join(home, '.rigorscope')), false);
    assert.equal(a.stdout, b.stdout);
    assert.ok(SIGNALS.length > 0, 'the registry is not empty');
    assert.equal(a.lines[0], `signals: ${SIGNALS.length} registered`);
    assert.deepEqual(a.lines.slice(1).map((l) => l.slice(0, l.indexOf(':'))), SIGNALS.map((s) => s.id));
  }));

  it('privacy: no output line holds a home, tmp or mount path prefix, the fixture home or the OS user name plant', () => using({ cases: 'all', units: true }, (home) => {
    for (const args of [[], ['--json'], ['--signals']]) {
      const raw = runCli(['doctor', ...args], { home, env: cliEnv(home) });
      assert.equal(raw.status, 0);
      const out = raw.stdout + raw.stderr;
      assert.ok(!out.includes(home), 'the fixture home path');
      assert.ok(!out.toLowerCase().includes(PLANTS.osUser.toLowerCase()), 'the OS user name plant');
      assert.ok(!/(?:^|[\s(=:"])\/(?:home|tmp|mnt|Users|var|root)\b/m.test(out), 'an absolute path prefix');
    }
  }));

  it('privacy: under the hostile systemctl scenario no hostile text appears and failing values print as ?', () => using({ cases: ['tracer-base'], units: true }, (home) => {
    const { FAKE_PATH } = fakePathFor(home, 'hostile');
    const raw = runCli(['doctor'], { home, env: cliEnv(home, { PATH: FAKE_PATH }) });
    assert.equal(raw.status, 0);
    for (const bad of ['touch x', '$(', PLANTS.osUser]) assert.ok(!raw.stdout.includes(bad), 'hostile text echoed');
    assert.match(lineOf(scrub(home, raw.stdout).split('\n'), 'service') ?? '', /^service: result=\?/);
  }));

  it('doctor with a fake systemctl asks only for show on the timer and the service, and never writes', () => using({ cases: ['tracer-base'], units: true }, (home) => {
    const { FAKE_PATH, logPath } = fakePathFor(home, 'active');
    const before = homeDigest(join(home, '.config'));
    const r = doctor(home, [], { PATH: FAKE_PATH });
    assert.equal(r.status, 0);
    const log = readFakeLog(logPath);
    assert.equal(log.length, 2, 'exactly two systemctl probes');
    assert.ok(log.every((l) => l.startsWith('--user show rigorscope-ingest.')));
    assert.equal(homeDigest(join(home, '.config')), before);
    assert.match(lineOf(r.lines, 'timer') ?? '', /^timer: active /);
  }));

  it('privacy: the doctor sources never name the main Claude Code config file', () => {
    const name = CACHE_FILE_NAME;
    assert.ok(typeof name === 'string' && name.length > 0);
    const files = ['src/report/doctor.mjs', 'src/commands/doctor.mjs', 'src/measure/doctor.mjs', 'src/report/usage-lead.mjs', 'src/report/render-doctor.mjs'];
    for (const f of files) {
      const p = new URL(`../../${f}`, import.meta.url);
      assert.ok(existsSync(p), `${f} exists`);
      assert.ok(!readFileSync(p, 'utf8').includes(name), `${f} does not name the config file`);
    }
  });
});

// Plan 02-01 (D-23 Q9): doctor on a store with a pending migration. It reports it and exits 0, and its lazy rebuild is
// refused (the guard), so the derived figures are unavailable with reason migration_pending. Nothing is written to
// store.db's main file. The latest version is computed from the migration files, never written as a literal.
describe('doctor and a pending store migration', () => {
  async function versions() {
    const { loadMigrations } = await mod('db.mjs');
    const all = await loadMigrations(new URL('../../src/store/migrations/', import.meta.url).pathname);
    return { all, latest: all[all.length - 1].version };
  }

  it('a pending store: exit 0, the store line shows latest and pending, the migration_pending problem, and no byte changed', () => using({}, async (home) => {
    const { openStore, storePath } = await mod('db.mjs');
    const { all, latest } = await versions();
    openStore({ home, migrations: all.slice(0, latest - 1) }).close();
    const sha = sha256File(storePath(home));
    const r = doctor(home);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.match(lineOf(r.lines, 'store') ?? '', new RegExp(`^store: schema=v${latest - 1} latest=v${latest} pending=1 `));
    assert.ok(r.lines.some((l) => l.startsWith('  problem migration_pending: ')), 'the migration_pending finding');
    assert.ok(r.lines.some((l) => l.startsWith('  problem derived_unavailable: ')), 'the derived figures are unavailable');
    const json = jsonOf(doctor(home, ['--json']));
    assert.equal(get(json, 'store.latest'), latest);
    assert.equal(get(json, 'store.pending'), 1);
    assert.equal(get(json, 'derived.reason'), 'migration_pending');
    assert.equal(sha256File(storePath(home)), sha, 'main-file bytes unchanged');
    assert.equal(existsSync(join(home, '.rigorscope', 'derived.db')), false, 'no derived.db was built');
  }));

  it('a store at the latest version: pending=0 and no migration_pending finding', () => using({}, async (home) => {
    const { openStore } = await mod('db.mjs');
    const { latest } = await versions();
    openStore({ home }).close();
    const r = doctor(home);
    assert.equal(r.status, 0, r.stderr);
    assert.match(lineOf(r.lines, 'store') ?? '', new RegExp(`^store: schema=v${latest} latest=v${latest} pending=0 `));
    assert.ok(!r.lines.some((l) => l.includes('migration_pending')));
    const json = jsonOf(doctor(home, ['--json']));
    assert.equal(get(json, 'store.pending'), 0);
  }));
});

// Plan 03.1-04 (ADPT-04, D-09, D-21): the doctor sections unit-locations, roster and unclassified, and the roster_drift lead.
// Expectations are computed by hand from the stock layout tables and the roster file as plain JSON.
describe('doctor roster sections', () => {
  const ROSTER = JSON.parse(readFileSync(new URL('../../src/adapters/gsd-core/roster.json', import.meta.url), 'utf8'));
  const REF12 = ROSTER.ref.slice(0, 12);
  const SHOWN = LOCATION_KINDS.filter((k) => k !== 'trees_scanned');

  // A home with one repo whose planning dir is built by `build`, ingested through the CLI.
  async function withRepo(name, build, fn) {
    const ctx = makeHome();
    plantFakeNode(ctx.home);
    linkCheckout(ctx.home);
    try {
      const repo = join(ctx.home, 'src', name);
      makeRepo(repo, { home: ctx.home, files: { 'README.md': `${name}\n` } });
      build(repo);
      const env = { RIGORSCOPE_REPO_ROOTS: repo, TZ: 'UTC' };
      const ing = runCli(['ingest'], { home: ctx.home, env: cliEnv(ctx.home, env) });
      assert.equal(ing.status, 0, ing.stderr);
      return await fn(ctx.home, env, `~/src/${name}/.git`);
    } finally {
      ctx.cleanup();
    }
  }
  const archivedBuild = (repo) => STOCK_LAYOUTS.archived.build(repo, {});

  it('unit-locations: the totals of the latest scan and one detail line for a repo with a not-read count', () => withRepo('arch', archivedBuild, (home, env, repoKey) => {
    const r = doctor(home, [], env);
    const counters = STOCK_LAYOUTS.archived.expect.counters;
    const want = `unit-locations: repos=1 ${SHOWN.map((k) => `${k}=${counters[k] ?? 0}`).join(' ')}`;
    assert.equal(lineOf(r.lines, 'unit-locations'), want);
    assert.deepEqual(sectionOf(r.lines, 'unit-locations').slice(1), [`  repo ${repoKey} not_read_milestones_other_dir=1`]);
  }));

  it('unit-locations: a repeated id is summed per unit key and shows on its repo detail line', () => withRepo('reset', (repo) => {
    STOCK_LAYOUTS.reset.build(repo, {});
  }, (home, env, repoKey) => {
    const r = doctor(home, [], env);
    assert.match(lineOf(r.lines, 'unit-locations') ?? '', /^unit-locations: repos=1 units_archived=1 repeat_id=1 /);
    assert.deepEqual(sectionOf(r.lines, 'unit-locations').slice(1), [`  repo ${repoKey} repeat_id=1`]);
  }));

  it('unit-locations: a store with no unit scan is unavailable, not zero', () => using({}, (home) => {
    const r = doctor(home);
    assert.equal(lineOf(r.lines, 'unit-locations'), 'unit-locations: unavailable (no store)');
    assert.equal(lineOf(r.lines, 'unclassified'), 'unclassified: unavailable (no store)');
  }));

  it('unit-locations: a store scanned by an earlier release (no sentinel) is unavailable with the reason', () => using({ cases: ['tracer-base'] }, (home) => {
    const r = doctor(home);
    assert.match(lineOf(r.lines, 'unit-locations') ?? '', /^unit-locations: unavailable \(no unit scan recorded\)$/);
  }));

  it('roster: with no checkout and no recorded gsd version the drift is unknown with the reason, and the verdict has no roster finding', () => withRepo('norepo', archivedBuild, (home, env) => {
    const r = doctor(home, [], env);
    assert.equal(lineOf(r.lines, 'roster'), `roster: ref=${REF12} version=${ROSTER.version} entries=${ROSTER.entries.length} drift=unknown reason=no_installed_version`);
    assert.ok(sectionOf(r.lines, 'roster').some((l) => /not proven complete/.test(l)), 'the roster states it is a snapshot, not proven complete');
    assert.ok(!r.lines.some((l) => l.includes('roster_drift')));
  }));

  it('roster: an unusable checkout is unknown with its reason and never a finding; a relative value is env_invalid', () => withRepo('badco', archivedBuild, (home, env) => {
    const a = doctor(home, [], { ...env, RIGORSCOPE_GSD_CORE_CHECKOUT: '/nonexistent-checkout-dir' });
    assert.match(lineOf(a.lines, 'roster') ?? '', /drift=unknown reason=checkout_unusable$/);
    const b = doctor(home, [], { ...env, RIGORSCOPE_GSD_CORE_CHECKOUT: 'relative/dir' });
    assert.match(lineOf(b.lines, 'roster') ?? '', /drift=unknown reason=env_invalid$/);
    for (const r of [a, b]) {
      assert.ok(!r.lines.some((l) => l.includes('roster_drift')));
      assert.match(r.lines[0], /^doctor: (HEALTHY|UNVERIFIED|UNHEALTHY) /);
      assert.ok(!r.stdout.includes('nonexistent-checkout-dir') && !r.stdout.includes('relative/dir'), 'the value is never echoed');
    }
  }));

  it('roster: an installed version that differs raises the lead roster_drift; an equal one does not', () => withRepo('vers', archivedBuild, async (home, env) => {
    const { openStore } = await mod('db.mjs');
    const db = openStore({ home });
    try {
      const run = db.prepare('SELECT max(run_id) AS r FROM ingest_run').get().r;
      db.prepare("UPDATE env_snapshot SET gsd_version = '9.9.9', gsd_version_source = 'version-file' WHERE run_id = ?").run(run);
      if (db.prepare('SELECT count(*) AS n FROM env_snapshot WHERE run_id = ?').get(run).n === 0) {
        db.prepare("INSERT INTO env_snapshot (run_id, taken_utc, gsd_version, gsd_version_source) VALUES (?, '2026-10-28T12:00:00.000Z', '9.9.9', 'version-file')").run(run);
      }
    } finally {
      db.close();
    }
    const a = doctor(home, [], env);
    assert.equal(lineOf(a.lines, 'roster'), `roster: ref=${REF12} version=${ROSTER.version} entries=${ROSTER.entries.length} drift=version_differs installed=9.9.9`);
    const lead = a.lines.find((l) => l.startsWith('  lead roster_drift: '));
    assert.ok(lead, 'the lead is listed');
    assert.ok(lead.includes('9.9.9') && lead.includes(ROSTER.version));
    assert.match(a.lines[0], /leads=\d+/);
    const db2 = (await mod('db.mjs')).openStore({ home });
    try {
      db2.prepare('UPDATE env_snapshot SET gsd_version = ? WHERE run_id = (SELECT max(run_id) FROM env_snapshot)').run(ROSTER.version);
    } finally {
      db2.close();
    }
    const b = doctor(home, [], env);
    assert.match(lineOf(b.lines, 'roster') ?? '', /drift=same_version installed=/);
    assert.ok(!b.lines.some((l) => l.includes('roster_drift')));
  }));

  it('--json carries unit_locations, roster and unclassified as plain data (an unknown is null)', () => withRepo('json', archivedBuild, (home, env) => {
    const doc = jsonOf(doctor(home, ['--json'], env));
    assert.equal(doc.unit_locations?.repos, 1);
    assert.equal(doc.unit_locations?.totals?.units_archived, 2);
    assert.equal(doc.unit_locations?.totals?.not_read_milestones_other_dir, 1);
    assert.deepEqual(doc.unit_locations?.per_repo?.map((x) => x.repo), ['~/src/json/.git']);
    assert.equal(doc.roster?.ref, REF12);
    assert.equal(doc.roster?.entries, ROSTER.entries.length);
    assert.equal(doc.roster?.drift?.state, 'unknown');
    assert.equal(doc.roster?.drift?.reason, 'no_installed_version');
    assert.equal(doc.roster?.drift?.changed, null);
    assert.equal(typeof doc.unclassified?.roster_ref, 'string');
    assert.ok(!/NaN|Infinity/.test(JSON.stringify(doc)));
  }));

  it('--signals lists the roster and unit-locations signals with their doctor keys', () => using({}, (home) => {
    const r = doctor(home, ['--signals']);
    const line = (id) => r.lines.find((l) => l.startsWith(`${id}:`)) ?? '';
    assert.match(line('roster'), /doctor=\[roster, unclassified\] consumer=owner-report-trust/);
    assert.match(line('unit-locations'), /doctor=\[unit-locations\].*units=\[locations, repeats\]|units=\[locations, repeats\].*doctor=\[unit-locations\]/);
  }));

  it('a HOME with no gsd-core at all stays HEALTHY on an otherwise healthy fixture (unknown drift is not a finding)', () => using({ cases: ['tracer-base'], units: true }, async (home) => {
    const report = await load(home);
    assert.equal(get(report, 'roster.drift.state'), 'unknown');
    assert.ok(!ids(report).includes('roster_drift'));
    assert.equal(report.verdict, 'HEALTHY');
  }));
});
