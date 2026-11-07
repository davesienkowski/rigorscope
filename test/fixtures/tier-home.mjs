// The tier fixture of plan 02-08 (D-18, TRUST-06, TRUST-07, TRUST-08, TIER-02, RPT-01): one fixture repo `tiers` with 36
// generated quick units (one commit each, one write scope per costed unit), an overlap scope, a low-only scope and an
// unlinked scope, and the hand-computed expectations. A helper, not a test. It uses only test/fixtures/git-repo.mjs
// helpers, the transcript helpers of test/fixtures/build.mjs, the OTel helpers of test/fixtures/otel.mjs and node
// built-ins; every expectation is computed here from the generator constants, never from rigorscope output and never by
// importing src/. Read with TZ=UTC (every quick-id start is then the UTC midnight of its id date).
//
// Risk paths (picked from the shipped data/risk-rules-*.json; the fixture self-check in test/integration/tier-cli.test.mjs
// fails with the unit and its tags when a later table classifies them differently):
//   P_GATE  hooks/check  matched only by rule gate-hook-dir (tag gate-or-hook)
//   P_SEC   src/redact   matched only by rule sec-push-cred (tag security)
//   P_NONE  src/core     matched by no rule and not docs-only (known empty risk set)
//
// Units (all quick units of repo `tiers`; tier from the PLAN frontmatter unless noted):
//   ga0..gaa  11  gate-or-hook, tier A, costed; gaa has files_modified [P_GATE, P_SEC] (the multi-tag unit: it counts in
//                 the gate-or-hook and the security stratum); ga3 runs on model M2
//   gb0..gb9  10  gate-or-hook, tier B, costed; gb5 runs on a model absent from the price table (its dollars are unknown)
//   gba        1  gate-or-hook, no frontmatter tier, a PROBES-SKIPPED file whose first line starts "Tier B": tier B inferred
//                 (tier_signal probes-skipped), costed
//   gbb        1  gate-or-hook, tier B, no session (uncosted)
//   gc0..gc8   9  gate-or-hook, tier C, costed
//   gu0, gu1   2  gate-or-hook, no tier signal: gu0 costed, gu1 uncosted
//   nc0        1  tier C, files_modified [P_NONE] (risk stratum none), costed
//   uk0        1  tier A, no files_modified and no commit naming its id (risk unknown), costed
// Dates: quick-id start is the UTC midnight of the id day, the end is the unit's one commit. gb4 is alone on 2026-10-01; the
// other 35 units share days two at a time from 2026-10-02 (so quick intervals are NOT disjoint on a shared day, a deviation
// from the plan text recorded in the 02-08 SUMMARY; the sessions below make that harmless). The first unit of a day commits
// at 10:00 and calls at 08:00 and 08:05; the second commits at 16:00 and calls at 12:00 and 12:05; gb4 commits at 18:00 and
// calls at 09:00 and 09:05.
// Scopes: every costed unit has one main session (cwd the repo) with two calls and a Write of its own PLAN (a high
// tool-path link). O writes the PLANs of ga1 and ga2 (unattributed_overlap, multi-unit). L has no ref and calls at 13:00 and
// 13:05 on gb4's day, inside gb4's interval only (unattributed_overlap low-only in mode medium, attributed to gb4 in mode
// low). N works in a plain directory outside any repository (unlinked).
// Model M1 everywhere except ga3 (M2) and gb5 (a model with no price). Effort high, version 2.1.309, standard speed.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  makeAssistant, makeUsage, mangleHome, writeJsonl,
} from './build.mjs';
import {
  assertOutsideWorkTree, commitAt, makeRepo, writeFileAt,
} from './git-repo.mjs';
import { eventLine, evAttrs, liveDirFor, resourceAttrs } from './otel.mjs';

export const TIER_TIMES = Object.freeze({
  firstDay: '2026-10-01T00:00:00.000Z',
  lastDay: '2026-10-19T23:59:59.000Z',
  // The fixed clock of every tier-home command: after every time of the fixture.
  now: '2026-11-01T00:00:00Z',
});

export const P_GATE = 'hooks/check';
export const P_SEC = 'src/redact';
export const P_NONE = 'src/core';
export const MODEL_M1 = 'claude-opus-5-5';
export const MODEL_M2 = 'claude-sonnet-5-5';
export const MODEL_UNPRICED = 'claude-none-0-0';
export const REPO_NAME = 'tiers';
export const REPO_KEY = `~/repos/${REPO_NAME}/.git`;
const SLUG = 'fx';
const SESSION_PREFIX = '71e70000-0000-4000-8000';

// ---- the generated unit table --------------------------------------------------------------------------------------
// tokens: per costed unit the exact sum of its two calls' four token classes (medium mode).
const gate = [P_GATE];
function build() {
  const specs = [];
  const add = (s) => specs.push({
    files: gate, tier: null, probes: false, costed: true, model: MODEL_M1, commit: true, ...s,
  });
  for (let k = 0; k < 11; k += 1) {
    add({
      id: `ga${k.toString(36)}`, group: 'ga', tier: 'A', tokens: 2000 + 50 * k, lines: 5 + k,
      model: k === 3 ? MODEL_M2 : MODEL_M1, files: k === 10 ? [P_GATE, P_SEC] : gate,
    });
  }
  for (let k = 0; k < 10; k += 1) {
    add({
      id: `gb${k}`, group: 'gb', tier: 'B', tokens: 3000 + 40 * k, lines: 20 + k, model: k === 5 ? MODEL_UNPRICED : MODEL_M1,
    });
  }
  add({
    id: 'gba', group: 'gb', tier: null, probes: true, tokens: 3400, lines: 30,
  });
  add({
    id: 'gbb', group: 'gb', tier: 'B', costed: false, tokens: null, lines: 31,
  });
  for (let k = 0; k < 9; k += 1) {
    add({
      id: `gc${k}`, group: 'gc', tier: 'C', tokens: 2400 + 30 * k, lines: 40 + k,
    });
  }
  add({
    id: 'gu0', group: 'gu', tokens: 4000, lines: 50,
  });
  add({
    id: 'gu1', group: 'gu', costed: false, tokens: null, lines: 51,
  });
  add({
    id: 'nc0', group: 'nc', tier: 'C', files: [P_NONE], tokens: 4100, lines: 52,
  });
  add({
    id: 'uk0', group: 'uk', tier: 'A', files: null, commit: false, tokens: 4200, lines: null,
  });
  // dates: gb4 alone on day 1, the rest two per day from day 2
  const rest = specs.filter((s) => s.id !== 'gb4');
  const byId = new Map(specs.map((s) => [s.id, s]));
  const place = (s, day, slot) => {
    s.day = day;
    s.slot = slot;
    s.idFull = `2610${String(day).padStart(2, '0')}-${s.id}`;
    s.commitIso = `2026-10-${String(day).padStart(2, '0')}T${['10', '16', '18'][slot]}:00:00.000Z`;
    s.callIso = [0, 5].map((m) => `2026-10-${String(day).padStart(2, '0')}T${['08', '12', '09'][slot]}:0${m}:00.000Z`);
  };
  place(byId.get('gb4'), 1, 2);
  rest.forEach((s, i) => place(s, 2 + Math.floor(i / 2), i % 2));
  return specs;
}
export const TIER_SPEC = Object.freeze(build().map((s) => Object.freeze(s)));
const SPEC_BY_ID = new Map(TIER_SPEC.map((s) => [s.id, s]));
export const unitKeyOf = (id) => `gsd-core:${REPO_KEY}:quick:${SPEC_BY_ID.get(id).idFull}`;

const SPECIAL = Object.freeze({
  // O: unattributed_overlap multi-unit; L: low-only in medium, attributed to gb4 in low; N: unlinked.
  overlap: Object.freeze({ id: 'O', writes: ['ga1', 'ga2'], calls: [[0, 0, '2026-10-03T08:30:00.000Z'], [0, 0, '2026-10-03T08:35:00.000Z']] }),
  low: Object.freeze({ id: 'L', target: 'gb4', callIso: ['2026-10-01T13:00:00.000Z', '2026-10-01T13:05:00.000Z'] }),
  none: Object.freeze({ id: 'N', callIso: ['2026-10-04T09:00:00.000Z'] }),
});
const OVERLAP_TOKENS = [[11, 12, 13, 14], [21, 22, 23, 24]];
const LOW_TOKENS = [[31, 32, 33, 34], [41, 42, 43, 44]];
const NONE_TOKENS = [[51, 52, 53, 54]];
const sum = (a) => a.reduce((x, y) => x + y, 0);

// The two calls' token classes of one unit: [input, output, read, creation] each; the sum is the unit's tokens.
export function callsOf(tokens) {
  const fixed = 20 + 100 + 30 + 21 + 101 + 31;
  const a = Math.floor((tokens - fixed) / 2);
  const b = tokens - fixed - a;
  return [[a, 20, 100, 30], [b, 21, 101, 31]];
}

const sessionId = (n) => `${SESSION_PREFIX}-${String(n).padStart(12, '0')}`;
export const TIER_SESSIONS = Object.freeze({
  ...Object.fromEntries(TIER_SPEC.filter((s) => s.costed).map((s, i) => [s.id, sessionId(i + 1)])),
  O: sessionId(901), L: sessionId(902), N: sessionId(903), OTEL: sessionId(904),
});

// ---- hand-computed expectations ------------------------------------------------------------------------------------
const byteLess = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const rankOf = (p, n) => Math.min(n, Math.max(1, Math.floor((p * n + 99) / 100)));
const asc = (xs) => [...xs].sort((a, b) => a.v - b.v || byteLess(a.k, b.k));
const stat = (items, p) => {
  const s = asc(items);
  return s.length === 0 ? null : s[rankOf(p, s.length) - 1];
};

const riskStrata = (s) => {
  if (s.files === null) return ['unknown'];
  if (s.files.includes(P_NONE)) return ['none'];
  return s.files.includes(P_SEC) ? ['gate-or-hook', 'security'] : ['gate-or-hook'];
};
export const STRATUM_ORDER = Object.freeze(['gate-or-hook', 'security', 'parser', 'global-config', 'script', 'docs', 'none', 'unknown']);

// opts: includeInferred (the probes-skipped unit joins its letter row), mode ('medium' or 'low').
export function expectStrata({ includeInferred = false, mode = 'medium' } = {}) {
  const tokensOf = (s) => (s.costed ? s.tokens + (mode === 'low' && s.id === SPECIAL.low.target ? sum(LOW_TOKENS.map(sum)) : 0) : null);
  const strata = {};
  let inferredExcluded = 0;
  for (const s of TIER_SPEC) {
    let side;
    if (s.tier === null && !s.probes) side = '?';
    else if (s.probes) side = includeInferred ? 'B' : null;
    else side = s.tier;
    for (const name of riskStrata(s)) {
      if (!strata[name]) strata[name] = { rows: {}, inferredExcluded: 0 };
      if (side === null) { strata[name].inferredExcluded += 1; if (name === riskStrata(s)[0]) inferredExcluded += 1; continue; }
      const row = strata[name].rows[side] ?? (strata[name].rows[side] = { keys: [], items: [] });
      row.keys.push(unitKeyOf(s.id));
      if (s.costed) row.items.push({ k: unitKeyOf(s.id), v: tokensOf(s), id: s.id, from: `2026-10-${String(s.day).padStart(2, '0')}`, to: s.commitIso.slice(0, 10) });
    }
  }
  const out = [];
  for (const name of STRATUM_ORDER) {
    const st = strata[name];
    if (!st) continue;
    const rows = {};
    for (const side of ['A', 'B', 'C', '?']) {
      const r = st.rows[side] ?? { keys: [], items: [] };
      const med = stat(r.items, 50);
      const p75 = stat(r.items, 75);
      rows[side] = {
        keys: [...r.keys].sort(byteLess),
        n: r.keys.length,
        costed: r.items.length,
        tokens_median: med ? med.v : null,
        tokens_p75: p75 ? p75.v : null,
        median_key: med ? med.k : null,
        tokens_known: r.items.length,
      };
    }
    const letters = ['A', 'B', 'C'].filter((l) => rows[l].costed > 0).flatMap((l) => st.rows[l].items);
    const window = letters.length === 0 ? null : [letters.map((i) => i.from).sort()[0], letters.map((i) => i.to).sort().reverse()[0]];
    out.push({
      stratum: name, rows, inferredExcluded: st.inferredExcluded, window,
    });
  }
  return { strata: out, inferredExcluded };
}

// The leads of the gate-or-hook stratum: pairs of compared letter sides ordered by the smaller side's costed count
// (descending), then the absolute median token gap (descending), then pair order A-B, A-C, B-C.
export function expectLeads(strata) {
  const leads = [];
  for (const [si, st] of strata.entries()) {
    const sides = ['A', 'B', 'C'].filter((l) => st.rows[l].costed > 0);
    for (const [pi, [x, y]] of [['A', 'B'], ['A', 'C'], ['B', 'C']].entries()) {
      if (!sides.includes(x) || !sides.includes(y)) continue;
      const rx = st.rows[x];
      const ry = st.rows[y];
      leads.push({
        stratum: st.stratum,
        tiers: [x, y],
        costed: [rx.costed, ry.costed],
        median_tokens: [rx.tokens_median, ry.tokens_median],
        gap_tokens: Math.abs(rx.tokens_median - ry.tokens_median),
        median_keys: [rx.median_key, ry.median_key],
        order: [Math.min(rx.costed, ry.costed), Math.abs(rx.tokens_median - ry.tokens_median), si, pi],
      });
    }
  }
  leads.sort((a, b) => b.order[0] - a.order[0] || b.order[1] - a.order[1] || a.order[2] - b.order[2] || a.order[3] - b.order[3]);
  return leads;
}

// Attribution buckets of the main section: [calls, tokens] per bucket.
function bucketsOf(mode) {
  const costed = TIER_SPEC.filter((s) => s.costed);
  const attributed = [costed.length * 2, sum(costed.map((s) => s.tokens))];
  const overlap = [OVERLAP_TOKENS.length, sum(OVERLAP_TOKENS.map(sum))];
  const low = [LOW_TOKENS.length, sum(LOW_TOKENS.map(sum))];
  const none = [NONE_TOKENS.length, sum(NONE_TOKENS.map(sum))];
  if (mode === 'low') {
    return {
      attributed: [attributed[0] + low[0], attributed[1] + low[1]], overlap, unlinked: none,
      total: [attributed[0] + low[0] + overlap[0] + none[0], attributed[1] + low[1] + overlap[1] + none[1]],
    };
  }
  return {
    attributed, overlap: [overlap[0] + low[0], overlap[1] + low[1]], unlinked: none,
    total: [attributed[0] + overlap[0] + low[0] + none[0], attributed[1] + overlap[1] + low[1] + none[1]],
  };
}

const med = expectStrata();
export const TIER_EXPECTED = Object.freeze({
  units: Object.fromEntries(TIER_SPEC.map((s) => [s.id, unitKeyOf(s.id)])),
  keyOf: unitKeyOf,
  strata: med.strata,
  inferredExcluded: med.inferredExcluded,
  withInferred: expectStrata({ includeInferred: true }),
  low: expectStrata({ mode: 'low' }),
  leads: expectLeads(med.strata),
  leadsWithInferred: expectLeads(expectStrata({ includeInferred: true }).strata),
  leadsLow: expectLeads(expectStrata({ mode: 'low' }).strata),
  buckets: { medium: bucketsOf('medium'), low: bucketsOf('low') },
  // The intended risk tags per unit id and the intended tier letter and signal.
  riskTags: Object.fromEntries(TIER_SPEC.map((s) => [s.id, s.files === null ? null : (s.files.includes(P_NONE) ? [] : (s.files.includes(P_SEC) ? ['gate-or-hook', 'security'] : ['gate-or-hook']))])),
  tiers: Object.fromEntries(TIER_SPEC.map((s) => [s.id, s.probes ? { tier: 'B', signal: 'probes-skipped' } : (s.tier === null ? { tier: null, signal: 'none' } : { tier: s.tier, signal: 'frontmatter' })])),
  costedIds: TIER_SPEC.filter((s) => s.costed).map((s) => s.id),
  // TRUST-06 (gate-or-hook, default run): categorical model values differ (M1, M2, the unpriced name), unit_size medians
  // differ by side, everything else known is unchanged, the seven env names are unknown for every unit.
  confounders: {
    changed: ['model', 'unit_size'],
    unchangedCount: 7,
    unchanged: ['effort', 'speed', 'cc_version', 'worker_mode', 'worker_count', 'subagents', 'repo'],
    unknown: ['gsd_version', 'base_sha', 'local_mods_head', 'hooks_sha', 'hook_events', 'model_default', 'advisor_model'],
    modelValues: [MODEL_M1, MODEL_M2, MODEL_UNPRICED],
    // nearest-rank medians of added plus deleted lines per side (unit_size), default run
    sizeMedians: (() => {
      const m = {};
      for (const side of ['A', 'B', 'C']) {
        const items = TIER_SPEC.filter((s) => s.costed && s.tier === side && !s.probes && riskStrata(s).includes('gate-or-hook'))
          .map((s) => ({ k: unitKeyOf(s.id), v: s.lines }));
        m[side] = stat(items, 50).v;
      }
      return m;
    })(),
  },
  special: SPECIAL,
  sessions: TIER_SESSIONS,
  models: { m1: MODEL_M1, m2: MODEL_M2, unpriced: MODEL_UNPRICED },
  main: { role: 'main' },
  repoName: REPO_NAME,
  repoKey: REPO_KEY,
  tokens: { overlap: OVERLAP_TOKENS.map(sum), low: LOW_TOKENS.map(sum), none: NONE_TOKENS.map(sum) },
});

// ---- the build ------------------------------------------------------------------------------------------------------
const md = (front) => `${['---', ...front, '---', '', 'tier fixture body', ''].join('\n')}\n`;
const planFront = (s) => [
  ...(s.tier === null ? [] : [`tier: ${s.tier}`]),
  ...(s.files === null ? [] : ['files_modified:', ...s.files.map((f) => `  - ${f}`)]),
];
const dirOf = (s) => `.planning/quick/${s.idFull}-${SLUG}`;
const planPath = (s) => `${dirOf(s)}/${s.idFull}-PLAN.md`;

function buildRepo(repo, home) {
  makeRepo(repo, { home, files: { 'README.md': 'tiers\n' } });
  const ordered = [...TIER_SPEC].sort((a, b) => Date.parse(a.commitIso) - Date.parse(b.commitIso));
  for (const s of ordered) {
    writeFileAt(repo, planPath(s), md(planFront(s)));
    if (s.probes) writeFileAt(repo, `${dirOf(s)}/${s.idFull}-PROBES-SKIPPED.md`, 'Tier B -- fixture reason for skipping the probes\n');
    if (s.commit) {
      writeFileAt(repo, `src/u-${s.id}.mjs`, Array.from({ length: s.lines }, (_, i) => `export const v${i} = ${i};\n`).join(''));
      commitAt(repo, { home, date: s.commitIso, message: `feat(${s.idFull}): ${s.group} unit` });
    } else {
      commitAt(repo, { home, date: s.commitIso, message: 'docs: add a fixture plan' });
    }
  }
}

const callLine = ({
  session, ts, id, model, cwd, use, content,
}) => JSON.stringify(makeAssistant({
  session, ts, id, model, cwd, use: makeUsage({
    input: use[0], output: use[1], read: use[2], creation: use[3], c5: use[3], c1: 0,
  }),
  ...(content ? { content: [...content, { type: 'text', text: 'ok' }] } : {}),
}));
const writeTool = (path, n) => ({
  type: 'tool_use', id: `toolu_tier_${n}`, name: 'Write', input: { file_path: path },
});

function writeSessions(root, places) {
  let n = 0;
  const put = (cwd, session, lines) => writeJsonl(join(root, 'projects', mangleHome(cwd), `${session}.jsonl`), lines);
  for (const s of TIER_SPEC.filter((x) => x.costed)) {
    const session = TIER_SESSIONS[s.id];
    n += 1;
    const calls = callsOf(s.tokens);
    put(places.repo, session, calls.map((use, i) => callLine({
      session, ts: s.callIso[i], id: `msg_tier_${s.id}_${i}`, model: s.model, cwd: places.repo, use,
      ...(i === 0 ? { content: [writeTool(join(places.repo, planPath(s)), n)] } : {}),
    })));
  }
  const o = SPECIAL.overlap;
  put(places.repo, TIER_SESSIONS.O, OVERLAP_TOKENS.map((use, i) => callLine({
    session: TIER_SESSIONS.O, ts: o.calls[i][2], id: `msg_tier_o_${i}`, model: MODEL_M1, cwd: places.repo, use,
    content: i === 0 ? o.writes.map((id, j) => writeTool(join(places.repo, planPath(SPEC_BY_ID.get(id))), 900 + j)) : undefined,
  })));
  put(places.repo, TIER_SESSIONS.L, LOW_TOKENS.map((use, i) => callLine({
    session: TIER_SESSIONS.L, ts: SPECIAL.low.callIso[i], id: `msg_tier_l_${i}`, model: MODEL_M1, cwd: places.repo, use,
  })));
  put(places.plain, TIER_SESSIONS.N, NONE_TOKENS.map((use, i) => callLine({
    session: TIER_SESSIONS.N, ts: SPECIAL.none.callIso[i], id: `msg_tier_n_${i}`, model: MODEL_M1, cwd: places.plain, use,
  })));
}

// One OTel api_request in the session of ga0 (a costed gate-or-hook A unit) that joins no transcript call: it prints in the
// otel-only section of `cost`. Written only when asked (it changes the freshness block and the OTel counts).
function writeOtelOnly(home) {
  const dir = liveDirFor(home);
  mkdirSync(dir, { recursive: true });
  const ts = '2026-10-02T08:02:00.000Z';
  const line = eventLine({
    ts,
    event: 'api_request',
    resource: resourceAttrs(),
    attrs: evAttrs({
      session: TIER_SESSIONS.ga0, seq: 1, ts, name: 'api_request',
      extra: {
        'prompt.id': 'prompt-tier-otel', request_id: 'req_tier_otel_only', query_source: 'agent:builtin:general-purpose', model: MODEL_M1,
        input_tokens: 7, output_tokens: 8, cache_read_tokens: 9, cache_creation_tokens: 10, cost_usd: 0.000123,
      },
    }),
  });
  writeJsonl(join(dir, 'events-2026-10-02.jsonl'), [line]);
}

// -> { repo, plain, expected }. options: otelOnly (also write the one otel-only request).
export function buildTierHome({ home, root = join(home, '.claude'), otelOnly = false } = {}) {
  assertOutsideWorkTree(dirname(home));
  const places = { repo: join(home, 'repos', REPO_NAME), plain: join(home, 'work', 'plain') };
  buildRepo(places.repo, home);
  mkdirSync(places.plain, { recursive: true });
  writeSessions(root, places);
  if (otelOnly) writeOtelOnly(home);
  return { ...places, expected: TIER_EXPECTED };
}
