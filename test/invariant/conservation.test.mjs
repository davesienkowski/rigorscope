// Plan 01-04 invariant: token conservation per class, per role and per model (COST-01, D-12). For every
// token class the sum over roles, the sum over models, the total over api_call_part and the store-side
// total agree by known sum and known count; the parts also equal the hand-computed totals and the
// independent recount from the raw store (tokenTotalsFromStore, which imports nothing from src/derive).
// The check is proven able to fail by tampering with derived.db. Written before the code (RED).
//
// Assumed shapes: checkConservation(db) -> { ok, classes: [{ column, total, roles, models, store, ok }],
// counts, violations }, each leg { sum, known }.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFixtureTree, makeHome, shuffleLines, windowsUsersDirFor,
} from '../fixtures/build.mjs';
import {
  CLASSES, derivedDigest, openTempStore, queryOrEmpty, tokenTotalsFromStore,
} from '../fixtures/derive-rows.mjs';
import * as dups from '../fixtures/cases/70-derive-dups.mjs';
import * as roles from '../fixtures/cases/80-derive-roles-iter.mjs';
import { Db, derivedPath, openDerivedReadOnly, openStoreReadOnly } from '../../src/db.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const NOW = () => new Date('2026-10-28T05:00:00.000Z');

// Hand-computed per-class [known sum, known part count] for the two cases without a totals export.
const ITERATIONS_TOTALS = {
  input_tokens: [139, 3], output_tokens: [69, 3], cache_read: [1009, 3], cache_creation: [59, 3], cache_5m: [59, 3], cache_1h: [0, 3],
};
const TRACER_TOTALS = {
  input_tokens: [212, 8], output_tokens: [116, 8], cache_read: [6607, 8], cache_creation: [438, 7], cache_5m: [200, 1], cache_1h: [100, 1],
};

async function derived(cases, { ownerRule, order, shuffle = false } = {}) {
  const ctx = makeHome();
  await buildFixtureTree(ctx.root, { home: ctx.home, cases });
  if (shuffle) {
    const walk = (d) => {
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (n.endsWith('.jsonl')) shuffleLines(p, 7);
      }
    };
    walk(join(ctx.root, 'projects'));
  }
  const { runIngest } = await mod('ingest/run.mjs');
  await runIngest({ home: ctx.home, env: { HOME: ctx.home }, windowsUsersDir: windowsUsersDirFor(ctx.home), now: NOW, order });
  const { rebuildDerived } = await mod('derive/rebuild.mjs');
  rebuildDerived({ home: ctx.home, now: NOW, ownerRule });
  return ctx;
}

function check(home) {
  return mod('derive/conservation.mjs').then(({ checkConservation }) => {
    const db = openDerivedReadOnly({ home });
    try {
      return checkConservation(db);
    } finally {
      db.close();
    }
  });
}

function recount(home) {
  const db = openStoreReadOnly({ home });
  try {
    return tokenTotalsFromStore(db);
  } finally {
    db.close();
  }
}

function legOf(result, column) {
  const c = (result.classes ?? []).find((x) => x.column === column);
  assert.ok(c, `class ${column} is reported`);
  return c;
}

async function assertConserved(home, totals) {
  const r = await check(home);
  assert.equal(r.ok, true, 'conservation holds');
  assert.deepEqual(r.violations, []);
  const store = recount(home);
  for (const column of CLASSES) {
    const c = legOf(r, column);
    const [sum, known] = totals[column];
    assert.deepEqual({ ...c.total }, { sum, known }, `${column}: parts total equals the hand-computed total`);
    assert.deepEqual({ ...c.roles }, { sum, known }, `${column}: role sums`);
    assert.deepEqual({ ...c.models }, { sum, known }, `${column}: model sums`);
    assert.deepEqual({ ...c.store }, { sum, known }, `${column}: store-side total`);
    assert.equal(store[column].sum, sum, `${column}: independent recount from the raw store`);
  }
}

describe('conservation on the hand-computed cases', () => {
  it('iterations: advisor parts conserve every class', async () => {
    const ctx = await derived(['iterations']);
    try {
      await assertConserved(ctx.home, ITERATIONS_TOTALS);
    } finally {
      ctx.cleanup();
    }
  });

  it('derive-dups: duplicates count once and the synthetic line contributes nothing', async () => {
    const ctx = await derived(['derive-dups']);
    try {
      await assertConserved(ctx.home, dups.expectedDerived.totals);
    } finally {
      ctx.cleanup();
    }
  });

  it('derive-roles-iter: mismatch, unknown type and NULL advisor model conserve every class', async () => {
    const ctx = await derived(['derive-roles-iter']);
    try {
      await assertConserved(ctx.home, roles.expectedDerived.totals);
    } finally {
      ctx.cleanup();
    }
  });

  it('tracer group: unknown members stay out of the known sums and are counted, never zeroed', async () => {
    const ctx = await derived(['tracer-base']);
    try {
      await assertConserved(ctx.home, TRACER_TOTALS);
    } finally {
      ctx.cleanup();
    }
  });

  it('per model, the derived parts equal the hand-computed model rows', async () => {
    const ctx = await derived(['derive-roles-iter']);
    try {
      const db = openDerivedReadOnly({ home: ctx.home });
      let rows;
      try {
        rows = queryOrEmpty(db, `SELECT model, count(DISTINCT call_key) AS calls, sum(input_tokens) AS i, sum(output_tokens) AS o,
          sum(cache_read) AS r, sum(cache_creation) AS w FROM api_call_part GROUP BY model ORDER BY model ASC NULLS LAST`);
      } finally {
        db.close();
      }
      assert.deepEqual(rows.map((x) => [x.model ?? '?', ...[x.calls, x.i, x.o, x.r, x.w].map(String)]), roles.expectedDerived.rowsByModel);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('order and owner independence', () => {
  const CASES = ['iterations', 'derive-dups', 'derive-roles-iter'];

  it('owner rules earliest and latest give equal totals per class and per model', async () => {
    const a = await derived(CASES, { ownerRule: 'earliest' });
    const b = await derived(CASES, { ownerRule: 'latest' });
    try {
      const perModel = (home) => {
        const db = openDerivedReadOnly({ home });
        try {
          return queryOrEmpty(db, `SELECT model, ${CLASSES.map((c) => `sum(${c}) AS ${c}`).join(', ')} FROM api_call_part GROUP BY model ORDER BY model`);
        } finally {
          db.close();
        }
      };
      const ra = await check(a.home);
      const rb = await check(b.home);
      assert.equal(ra.ok, true);
      assert.equal(rb.ok, true);
      for (const column of CLASSES) assert.deepEqual({ ...legOf(rb, column).total }, { ...legOf(ra, column).total }, column);
      assert.ok(perModel(a.home).length >= 5, 'models present');
      assert.deepEqual(perModel(b.home), perModel(a.home));
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('reversed file order and shuffled line order at ingest give the same derived content digest', async () => {
    const a = await derived(CASES);
    const b = await derived(CASES, { order: 'reverse', shuffle: true });
    try {
      const digest = (home) => {
        const db = openDerivedReadOnly({ home });
        try {
          return { d: derivedDigest(db), n: queryOrEmpty(db, 'SELECT count(*) AS n FROM api_call_part')[0]?.n };
        } finally {
          db.close();
        }
      };
      const da = digest(a.home);
      assert.equal(da.n, 18, 'three cases, eighteen parts');
      assert.deepEqual(digest(b.home), da);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});

describe('conservation has teeth', () => {
  const tamper = async (sql) => {
    const ctx = await derived(['derive-roles-iter']);
    const before = await check(ctx.home);
    assert.equal(before.ok, true, 'conservation holds before the tamper');
    const db = new Db(derivedPath(ctx.home));
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(sql);
    } finally {
      db.close();
    }
    return { ctx, before, after: await check(ctx.home) };
  };

  it('fails when a part is deleted', async () => {
    const { ctx, before, after } = await tamper("DELETE FROM api_call_part WHERE kind = 'advisor' AND model = 'claude-fable-5-0'");
    try {
      assert.equal(before.ok, true, 'holds before the tamper');
      assert.equal(after.ok, false);
      assert.ok(after.violations.some((v) => v.column === 'input_tokens'), 'the input class is named');
    } finally {
      ctx.cleanup();
    }
  });

  it('fails when an orphan part is added', async () => {
    const { ctx, before, after } = await tamper(
      "INSERT INTO api_call_part (call_key, part_seq, kind, model, input_tokens, output_tokens, cache_read, cache_creation, cache_5m, cache_1h) VALUES ('m:no-such-call', 0, 'message', 'claude-opus-5-5', 1, 1, 1, 1, 1, 0)",
    );
    try {
      assert.equal(before.ok, true);
      assert.equal(after.ok, false);
      assert.ok(after.violations.some((v) => v.name === 'orphan_parts' && v.n === 1), 'the orphan is counted');
    } finally {
      ctx.cleanup();
    }
  });

  it('fails when a token value is altered, and the violation holds names and numbers only', async () => {
    const { ctx, before, after } = await tamper("UPDATE api_call_part SET cache_read = cache_read + 5 WHERE call_key = 'm:msg_r1'");
    try {
      assert.equal(before.ok, true);
      assert.equal(after.ok, false);
      const v = after.violations.find((x) => x.column === 'cache_read');
      assert.ok(v, 'cache_read is named');
      for (const value of Object.values(v)) assert.ok(value === null || ['string', 'number'].includes(typeof value));
      assert.ok(!after.violations.some((x) => x.column === 'input_tokens'), 'an untouched class is not named');
    } finally {
      ctx.cleanup();
    }
  });

  it('fails when a call loses its only part', async () => {
    const { ctx, after } = await tamper("DELETE FROM api_call_part WHERE call_key = 'm:msg_i5'");
    try {
      assert.equal(after.ok, false);
      assert.ok(after.violations.some((v) => v.name === 'calls_without_parts' && v.n === 1));
    } finally {
      ctx.cleanup();
    }
  });

  it('an empty store passes vacuously with unknown sums and zero known counts', async () => {
    const ctx = makeHome();
    try {
      openTempStore({ home: ctx.home }).close();
      const { rebuildDerived } = await mod('derive/rebuild.mjs');
      rebuildDerived({ home: ctx.home, now: NOW });
      const r = await check(ctx.home);
      assert.equal(r.ok, true);
      for (const column of CLASSES) assert.deepEqual({ ...legOf(r, column).total }, { sum: null, known: 0 });
    } finally {
      ctx.cleanup();
    }
  });
});
