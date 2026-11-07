// Plan 01-09 contract for src/measure/doctor.mjs (TRUST-05, RR-04): shape checks, the finding catalog, the verdict
// precedence, thresholds one step either side, and the integer basis-point rate. Written before the code (RED). The
// report fragment is the doctor model of the loader (see the typedef at the top of src/measure/doctor.mjs); every
// fragment here is built from BASE by one change. Results are read with ?. so RED fails on assertions.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const mod = () => import(new URL('../../src/measure/doctor.mjs', import.meta.url).href);
const SRC = new URL('../../src/measure/doctor.mjs', import.meta.url);

const BASE = () => ({
  store: { present: true, ok: 1, last_run: { status: 'ok' } },
  lock: { present: false, age_sec: null, limit_sec: 21600 },
  freshness: { sources: [{ name: 'transcript', state: 'ok' }, { name: 'otel', state: 'empty' }, { name: 'usage', state: 'not_rated' }] },
  roots: { not_seen: [] },
  null_session_id: { transcript: { total: 0, last_run: 0 }, otel: { total: null, last_run: null } },
  unknown_token_bearing: { records: 0 },
  unknown_attr: { names: 0 },
  agent_names: { disagree: 0 },
  usage: { age_sec: 100, limit_sec: 604800 },
  discontinuity: { five_hour: 0, seven_day: 0 },
  timer: { state: 'active', drift: false },
  service: { ok: true },
  unit_node: { status: 'ok' },
  derived: { ok: true },
});
const set = (o, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((a, k) => a[k], o)[last] = value;
  return o;
};
const idsOf = (r) => (r ?? []).map((f) => f.id);

describe('doctor measure: constants', () => {
  it('DOCTOR_KEYS is the fixed section order', async () => {
    const { DOCTOR_KEYS } = await mod();
    assert.deepEqual(DOCTOR_KEYS, [
      'freshness', 'store', 'lock', 'roots', 'cursors', 'null-session-id', 'unknown-token-bearing', 'unknown-attr',
      'ledger-lines', 'unit-locations', 'roster', 'unclassified', 'join-miss', 'agent-names', 'usage', 'discontinuity', 'timer', 'service', 'unit-node',
    ]);
  });

  it('FINDING_CATALOG lists the ids in catalog order, each with a class', async () => {
    const { FINDING_CATALOG } = await mod();
    assert.deepEqual((FINDING_CATALOG ?? []).map((f) => `${f.cls}:${f.id}`), [
      'problem:no_store', 'problem:migration_pending', 'problem:source_stale', 'problem:last_run_failed', 'problem:lock_old', 'problem:timer_missing',
      'problem:timer_inactive', 'problem:timer_not_enabled', 'problem:service_failed', 'problem:unit_node_missing',
      'problem:unit_node_below_floor', 'problem:derived_unavailable', 'unverified:timer_unverified',
      'unverified:unit_node_unverified', 'lead:unknown_token_bearing', 'lead:unknown_attr', 'lead:null_session_id',
      'lead:agent_name_disagreement', 'lead:usage_discontinuity', 'lead:snapshot_old', 'lead:root_not_seen', 'lead:unit_drift',
      'lead:roster_drift', 'lead:timer_not_configured',
    ]);
  });

  it('measure/doctor.mjs has no Date parse, no float parse and no float formatting', () => {
    assert.ok(existsSync(SRC));
    const src = readFileSync(SRC, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/Date\.parse|new Date|parseFloat|toFixed|Number\.parseFloat/.test(src));
  });
});

describe('doctor measure: shape checks', () => {
  const ROWS = [
    ['source', 'transcript', 'transcript'], ['source', 'otel', 'otel'], ['source', 'Bad Source', '?'], ['source', '', '?'],
    ['source', 'a'.repeat(33), '?'],
    ['scope', 'line', 'line'], ['scope', 'usage.cache:x', 'usage.cache:x'], ['scope', 'a b', '?'], ['scope', '?', '?'],
    ['attr', 'brandNewField', 'brandNewField'], ['attr', '?', '?'], ['attr', 'bad name; rm', '?'], ['attr', 'x'.repeat(65), '?'],
    ['token', 'mystery-usage|2.9.9', 'mystery-usage|2.9.9'], ['token', 'a b|1', '?'], ['token', 'name-only', '?'], ['token', 'n|1.0.0+build', 'n|1.0.0+build'],
    ['error', 'ENOENT', 'ENOENT'], ['error', 'bad code', '?'],
    ['status', 'ok', 'ok'], ['status', 'failed', 'failed'], ['status', 'OK; x', '?'],
    ['display', '~/.claude', '~/.claude'], ['display', '/srv/x/.claude', '?'], ['display', '$CLAUDE_CONFIG_DIR', '$CLAUDE_CONFIG_DIR'],
  ];
  for (const [kind, input, expected] of ROWS) {
    it(`safeTokenOrUnknown(${kind}, ${JSON.stringify(input.length > 20 ? `${input.slice(0, 8)}...` : input)}) is ${JSON.stringify(expected.length > 20 ? `${expected.slice(0, 8)}...` : expected)}`, async () => {
      const { safeTokenOrUnknown } = await mod();
      assert.equal(safeTokenOrUnknown(kind, input), expected);
    });
  }

  it('safeToken returns null for a failing value and the value for a passing one; a non-string is null', async () => {
    const { safeToken } = await mod();
    assert.equal(safeToken('source', 'otel'), 'otel');
    assert.equal(safeToken('source', 'No'), null);
    assert.equal(safeToken('source', 7), null);
    assert.equal(safeToken('source', undefined), null);
  });

  it('safeToken throws on an unknown kind so a typo cannot pass everything', async () => {
    const { safeToken } = await mod();
    assert.throws(() => safeToken('nonsense', 'x'));
  });
});

describe('doctor measure: missRate', () => {
  // bp = floor((m x 10000 + d / 2) / d) (half up). 9/15 = 6000; 7/13 = 5384.6 -> 5385; 5/10 = 5000; 1/3 = 3333.3 -> 3333;
  // 2/3 = 6666.7 -> 6667; 1/8 = 1250 exactly; 1/16 = 625 exactly; 0/5 = 0.
  const ROWS = [
    [9, 15, 6000, '9/15 (60.00%)'], [7, 13, 5385, '7/13 (53.85%)'], [5, 10, 5000, '5/10 (50.00%)'], [1, 3, 3333, '1/3 (33.33%)'],
    [2, 3, 6667, '2/3 (66.67%)'], [1, 8, 1250, '1/8 (12.50%)'], [1, 16, 625, '1/16 (6.25%)'], [0, 5, 0, '0/5 (0.00%)'],
    [0, 0, null, '0/0 (?)'],
  ];
  for (const [m, d, bp, text] of ROWS) {
    it(`missRate(${m}, ${d}) is ${bp === null ? 'unknown' : `${bp} bp`} and prints ${text}`, async () => {
      const { missRate } = await mod();
      const r = missRate(m, d);
      assert.equal(r?.bp, bp);
      assert.equal(r?.text, text);
      assert.equal(r?.misses, m);
      assert.equal(r?.denominator, d);
    });
  }
});

describe('doctor measure: the roster_drift text', () => {
  it('a checkout drift names the count, the ref and the sorted cited paths, and leaves the verdict HEALTHY', async () => {
    const { evaluateFindings, verdictOf } = await mod();
    const f = evaluateFindings(set(BASE(), 'roster', {
      ref: 'aaaaaaaaaaaa', version: '1.19.0', drift: { state: 'changed', changed: ['gsd-core/b.md', 'agents/a.md'], installed_version: null, reason: null },
    }));
    assert.equal(f.length, 1);
    assert.equal(f[0].id, 'roster_drift');
    assert.equal(f[0].cls, 'lead');
    assert.match(f[0].text, /^2 gsd-core paths cited by the roster changed since its ref aaaaaaaaaaaa: agents\/a\.md, gsd-core\/b\.md/);
    assert.equal(verdictOf(f), 'HEALTHY');
  });

  it('a version drift names both versions; a path that fails the shape is printed as ?', async () => {
    const { evaluateFindings } = await mod();
    const v = evaluateFindings(set(BASE(), 'roster', {
      ref: 'aaaaaaaaaaaa', version: '1.19.0', drift: { state: 'version_differs', changed: null, installed_version: '1.20.1', reason: null },
    }));
    assert.match(v[0].text, /1\.20\.1/);
    assert.match(v[0].text, /1\.19\.0/);
    const p = evaluateFindings(set(BASE(), 'roster', {
      ref: 'aaaaaaaaaaaa', version: '1.19.0', drift: { state: 'changed', changed: ['bad path; rm -rf'], installed_version: null, reason: null },
    }));
    assert.ok(!p[0].text.includes('rm -rf'));
    assert.match(p[0].text, /: \?/);
  });
});

describe('doctor measure: findings', () => {
  it('a healthy fragment yields no finding and HEALTHY', async () => {
    const { evaluateFindings, verdictOf } = await mod();
    const f = evaluateFindings(BASE());
    assert.deepEqual(f, []);
    assert.equal(verdictOf(f), 'HEALTHY');
  });

  // [title, mutation of BASE, expected ids in order, expected class of the first]
  const ROWS = [
    ['no store', (r) => set(r, 'store', { present: false }), ['no_store'], 'problem'],
    ['a store with no ok run', (r) => set(r, 'store.ok', 0), ['no_store'], 'problem'],
    ['a stale source', (r) => set(r, 'freshness.sources', [{ name: 'transcript', state: 'stale' }, { name: 'otel', state: 'never_run' }]), ['source_stale', 'source_stale'], 'problem'],
    ['a failed latest run', (r) => set(r, 'store.last_run', { status: 'failed' }), ['last_run_failed'], 'problem'],
    ['timer missing', (r) => set(r, 'timer.state', 'missing'), ['timer_missing'], 'problem'],
    ['timer not configured (no systemd) is a lead, not a problem', (r) => set(r, 'timer.state', 'not_configured'), ['timer_not_configured'], 'lead'],
    ['timer not configured hides the unit-node problems', (r) => set(set(r, 'timer.state', 'not_configured'), 'unit_node.status', 'below_floor'), ['timer_not_configured'], 'lead'],
    ['timer inactive', (r) => set(r, 'timer.state', 'inactive'), ['timer_inactive'], 'problem'],
    ['timer not enabled', (r) => set(r, 'timer.state', 'not_enabled'), ['timer_not_enabled'], 'problem'],
    ['timer unavailable', (r) => set(r, 'timer.state', 'unavailable'), ['timer_unverified'], 'unverified'],
    ['service failed', (r) => set(r, 'service.ok', false), ['service_failed'], 'problem'],
    ['service unknown raises nothing', (r) => set(r, 'service.ok', null), [], null],
    ['node missing', (r) => set(r, 'unit_node.status', 'not_found'), ['unit_node_missing'], 'problem'],
    ['node below floor', (r) => set(r, 'unit_node.status', 'below_floor'), ['unit_node_below_floor'], 'problem'],
    ['node without sqlite', (r) => set(r, 'unit_node.status', 'no_sqlite'), ['unit_node_below_floor'], 'problem'],
    // Plan 03.1-04 (D-09, J3): only a seen drift is a finding; an unknown drift is a section value.
    ['roster drift from a checkout (two cited paths) is a lead', (r) => set(r, 'roster', { ref: 'aaaaaaaaaaaa', version: '1.19.0', drift: { state: 'changed', changed: ['gsd-core/b.md', 'agents/a.md'], installed_version: null, reason: null } }), ['roster_drift'], 'lead'],
    ['roster checkout with no changed path raises nothing', (r) => set(r, 'roster', { drift: { state: 'changed', changed: [], installed_version: null, reason: null } }), [], null],
    ['roster version differs is a lead', (r) => set(r, 'roster', { ref: 'aaaaaaaaaaaa', version: '1.19.0', drift: { state: 'version_differs', changed: null, installed_version: '1.20.1', reason: null } }), ['roster_drift'], 'lead'],
    ['roster same version raises nothing', (r) => set(r, 'roster', { drift: { state: 'same_version', changed: null, installed_version: '1.19.0', reason: null } }), [], null],
    ['roster drift unknown raises nothing, whatever the reason', (r) => set(r, 'roster', { drift: { state: 'unknown', changed: null, installed_version: null, reason: 'no_installed_version' } }), [], null],
    ['roster section unavailable raises nothing', (r) => set(r, 'roster', { unavailable: 'no store' }), [], null],
    ['node unusable', (r) => set(r, 'unit_node.status', 'unusable'), ['unit_node_unverified'], 'unverified'],
    ['derived unavailable', (r) => set(r, 'derived.ok', false), ['derived_unavailable'], 'problem'],
    ['unknown token-bearing records', (r) => set(r, 'unknown_token_bearing.records', 3), ['unknown_token_bearing'], 'lead'],
    ['unknown attribute names', (r) => set(r, 'unknown_attr.names', 2), ['unknown_attr'], 'lead'],
    ['dropped session ids', (r) => set(r, 'null_session_id.transcript.total', 1), ['null_session_id'], 'lead'],
    ['agent-name disagreements', (r) => set(r, 'agent_names.disagree', 1), ['agent_name_disagreement'], 'lead'],
    ['a falling window percentage', (r) => set(r, 'discontinuity.seven_day', 1), ['usage_discontinuity'], 'lead'],
    ['an unseen root', (r) => set(r, 'roots.not_seen', [{ source: 'transcript', alias: 'g', last_seen_run: 1 }]), ['root_not_seen'], 'lead'],
    ['unit drift', (r) => set(r, 'timer.drift', true), ['unit_drift'], 'lead'],
  ];
  for (const [title, mutate, expected, cls] of ROWS) {
    it(`evaluateFindings: ${title} gives ${expected.length ? expected.join(', ') : 'nothing'}`, async () => {
      const { evaluateFindings } = await mod();
      const f = evaluateFindings(mutate(BASE()));
      assert.deepEqual(idsOf(f), expected);
      if (cls) assert.equal(f?.[0]?.cls, cls);
    });
  }

  // Plan 02-01: migration_pending is raised only for an integer store.pending above 0; an unknown is never a finding.
  for (const [pending, raised] of [[1, true], [2, true], [0, false], [null, false], [undefined, false], ['1', false], [1.5, false]]) {
    it(`evaluateFindings: store.pending ${JSON.stringify(pending) ?? 'missing'} ${raised ? 'raises' : 'does not raise'} migration_pending`, async () => {
      const { evaluateFindings } = await mod();
      const r = BASE();
      if (pending !== undefined) r.store.pending = pending;
      const f = evaluateFindings(r);
      assert.deepEqual(idsOf(f), raised ? ['migration_pending'] : []);
      if (raised) assert.equal(f?.[0]?.cls, 'problem');
    });
  }

  // Lock: limit 21600 s. 21600 is not old, 21601 is, a future age (-5) and an absent lock raise nothing.
  for (const [age, old] of [[21600, false], [21601, true], [-5, false], [null, false]]) {
    it(`evaluateFindings: lock age ${age} ${old ? 'raises' : 'does not raise'} lock_old`, async () => {
      const { evaluateFindings } = await mod();
      const r = set(set(BASE(), 'lock.age_sec', age), 'lock.present', age !== null);
      assert.equal(idsOf(evaluateFindings(r)).includes('lock_old'), old);
    });
  }

  // Snapshot: limit 604800 s (168 h x 3600). 604800 is not old, 604801 is; an unknown age raises nothing.
  for (const [age, old] of [[604800, false], [604801, true], [null, false]]) {
    it(`evaluateFindings: snapshot age ${age} ${old ? 'raises' : 'does not raise'} snapshot_old`, async () => {
      const { evaluateFindings } = await mod();
      assert.equal(idsOf(evaluateFindings(set(BASE(), 'usage.age_sec', age))).includes('snapshot_old'), old);
    });
  }

  it('evaluateFindings lists problems, then unverified, then leads, each in catalog order', async () => {
    const { evaluateFindings } = await mod();
    const r = set(set(set(set(BASE(), 'unknown_attr.names', 1), 'timer.state', 'unavailable'), 'timer.drift', true), 'derived.ok', false);
    assert.deepEqual(idsOf(evaluateFindings(r)), ['derived_unavailable', 'timer_unverified', 'unknown_attr', 'unit_drift']);
  });

  it('evaluateFindings texts are fixed ASCII with integer slots', async () => {
    const { evaluateFindings } = await mod();
    const f = evaluateFindings(set(set(BASE(), 'store', { present: false }), 'timer.state', 'missing'));
    assert.equal(f?.[0]?.text, 'no ingest has been recorded; run rigorscope ingest');
    assert.equal(f?.[1]?.text, 'the ingest timer is not installed; run rigorscope schedule install');
    const stale = evaluateFindings(set(BASE(), 'freshness.sources', [{ name: 'transcript', state: 'stale' }]));
    assert.equal(stale?.[0]?.text, 'source transcript is stale (see freshness)');
    const lock = evaluateFindings(set(set(BASE(), 'lock.age_sec', 21601), 'lock.present', true));
    assert.equal(lock?.[0]?.text, 'the ingest lock is 21601 s old, above the 21600 s unit timeout, so it cannot belong to a live run');
    for (const x of [...(f ?? []), ...(stale ?? []), ...(lock ?? [])]) assert.ok(!/[^\x20-\x7e]/.test(x.text));
  });

  it('a hostile source name in the freshness fragment is printed as ?', async () => {
    const { evaluateFindings } = await mod();
    const f = evaluateFindings(set(BASE(), 'freshness.sources', [{ name: 'bad name; rm', state: 'stale' }]));
    assert.equal(f?.[0]?.text, 'source ? is stale (see freshness)');
  });

  it('a section that is unavailable raises no finding from its own fields (unknown is never a finding or a pass)', async () => {
    const { evaluateFindings } = await mod();
    const r = BASE();
    r.unknown_attr = { unavailable: 'no store' };
    r.usage = { unavailable: 'no store' };
    r.lock = { unavailable: 'x' };
    assert.deepEqual(evaluateFindings(r), []);
  });
});

describe('doctor measure: verdict', () => {
  const f = (cls) => [{ cls, id: 'x', text: 't' }];
  const ROWS = [
    ['a problem alone', f('problem'), 'UNHEALTHY'], ['an unverified alone', f('unverified'), 'UNVERIFIED'], ['a lead alone', f('lead'), 'HEALTHY'],
    ['a problem and an unverified', [...f('unverified'), ...f('problem')], 'UNHEALTHY'], ['an unverified and a lead', [...f('lead'), ...f('unverified')], 'UNVERIFIED'],
    ['nothing', [], 'HEALTHY'],
  ];
  for (const [title, findings, verdict] of ROWS) {
    it(`verdictOf: ${title} is ${verdict}`, async () => {
      const { verdictOf } = await mod();
      assert.equal(verdictOf(findings), verdict);
    });
  }
});
