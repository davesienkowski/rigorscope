// Plan 01-04 Task 2: the named dedup owner rule and the dedup SELECT (D-03, D-12). Written before
// src/derive/owner.mjs. Stores are built row by row with the derive-rows helper and the SQL returned by
// dedupSelectSql is run against them through the read-only attach (schema s), as the derivation does.
//
// Owner ordering (rule earliest): unixepoch(ts_utc,'subsec') ASC, the occurrence's earliest file's
// first_record_utc ASC, that file's root alias ASC, its rel_path ASC, session_id ASC, agent_id ASC; NULL
// last in every term. Rule latest flips every direction (NULL still last). Tokens are the maximum over all
// non-synthetic occurrences whatever the owner.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, stateDirOf, windowsUsersDirFor, HELPERS, queryDb } from '../fixtures/build.mjs';
import { insertIter, insertMessage, insertMeta, openTempStore } from '../fixtures/derive-rows.mjs';
import { openDerivedForBuild } from '../../src/db.mjs';

const owner = await import(new URL('../../src/derive/owner.mjs', import.meta.url).href);
const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);

const T0 = '2026-10-27T10:00:01.000Z';
const T1 = '2026-10-27T10:00:02.000Z';

// rows: [{ session, agent, ts, model, tokens: [6], files: [{ alias, rel_path, first }], attribution, hasIterations, stu }]
// stu is has_server_tool_use (0 when the key is left out, so a NULL can be given explicitly).
function store(rows) {
  const ctx = makeHome();
  const db = openTempStore({ home: ctx.home });
  try {
    for (const r of rows) {
      const t = r.tokens ?? [1, 1, 1, 1, 1, 0];
      insertMessage(db, {
        session_id: r.session ?? 'S-a', agent_id: r.agent ?? '', message_id: r.message ?? 'm1', ts_utc: r.ts ?? null,
        model: r.model === undefined ? 'claude-opus-5-5' : r.model, attribution_agent: r.attribution ?? null,
        request_id: r.request ?? null, effort: r.effort ?? null, has_iterations: r.hasIterations ?? 0,
        has_server_tool_use: Object.hasOwn(r, 'stu') ? r.stu : 0,
        input_tokens: t[0], output_tokens: t[1], cache_read: t[2], cache_creation: t[3], cache_5m: t[4], cache_1h: t[5],
        files: (r.files ?? []).map((f) => ({ alias: f.alias ?? 'claude', rel_path: f.rel_path, first_record_utc: f.first ?? null })),
      });
    }
  } finally {
    db.close();
  }
  return ctx;
}

function select(ctx, rule) {
  const db = openDerivedForBuild({ tmpPath: join(stateDirOf(ctx.home), 'dedup-probe.db'), home: ctx.home });
  try {
    return db.prepare(owner.dedupSelectSql(rule)).all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

// The owner of message m1 under a rule, for the rows inserted in the given order.
function ownerOf(rows, rule) {
  const ctx = store(rows);
  try {
    const got = select(ctx, rule).find((r) => r.message_id === 'm1');
    assert.ok(got, 'message m1 selected');
    return [got.owner_session_id, got.owner_agent_id];
  } finally {
    ctx.cleanup();
  }
}

// Asserts the owner for both insertion orders and both rules.
function assertOwners(rows, earliest, latest) {
  for (const order of [rows, [...rows].reverse()]) {
    assert.deepEqual(ownerOf(order, 'earliest'), earliest, 'rule earliest');
    assert.deepEqual(ownerOf(order, 'latest'), latest, 'rule latest');
  }
}

describe('owner rule registry', () => {
  it('derives both rules from one term list: latest is earliest with every direction flipped', () => {
    assert.ok(Array.isArray(owner.OWNER_TERMS) && owner.OWNER_TERMS.length === 6, 'six terms');
    assert.deepEqual(Object.keys(owner.OWNER_RULES).sort(), ['earliest', 'latest']);
    assert.equal(owner.DEFAULT_OWNER_RULE, 'earliest');
    const e = owner.ownerOrderBy('earliest');
    const l = owner.ownerOrderBy('latest');
    assert.ok(e.includes("unixepoch(ts_utc,'subsec')"), 'the timestamp is compared as a number');
    assert.equal(l, e.replaceAll(' ASC NULLS LAST', ' DESC NULLS LAST'));
    assert.equal((e.match(/NULLS LAST/g) ?? []).length, 6);
  });

  it('throws for an unknown rule name, for SQL text and for a non-string', () => {
    for (const bad of ['earliest ', 'EARLIEST', 'ts_utc ASC', "unixepoch(ts_utc,'subsec') DESC", 'toString', '__proto__', '', 1, null, undefined, {}]) {
      assert.throws(() => owner.ownerOrderBy(bad), 'ownerOrderBy');
      assert.throws(() => owner.dedupSelectSql(bad), 'dedupSelectSql');
    }
  });
});

describe('owner ordering, both insertion orders and both rules', () => {
  it('the earlier timestamp wins', () => {
    assertOwners([{ session: 'S-a', ts: T1 }, { session: 'S-b', ts: T0 }], ['S-b', ''], ['S-a', '']);
  });

  it('timestamps that differ only in format tie, so the file time decides', () => {
    assertOwners([
      { session: 'S-a', ts: '2026-10-27T10:00:01Z', files: [{ rel_path: 'p/a.jsonl', first: T1 }] },
      { session: 'S-b', ts: '2026-10-27T10:00:01.000Z', files: [{ rel_path: 'p/b.jsonl', first: T0 }] },
    ], ['S-b', ''], ['S-a', '']);
  });

  it('a NULL timestamp loses under both rules', () => {
    assertOwners([{ session: 'S-a', ts: null }, { session: 'S-b', ts: T1 }, { session: 'S-c', ts: T0 }], ['S-c', ''], ['S-b', '']);
  });

  it('an occurrence stored in two files is judged by its earliest file', () => {
    assertOwners([
      { session: 'S-a', ts: T0, files: [{ rel_path: 'p/a1.jsonl', first: '2026-10-27T10:00:05.000Z' }, { rel_path: 'p/a2.jsonl', first: '2026-10-27T09:00:00.000Z' }] },
      { session: 'S-b', ts: T0, files: [{ rel_path: 'p/b.jsonl', first: '2026-10-27T09:30:00.000Z' }] },
    ], ['S-a', ''], ['S-b', '']);
  });

  it('then the root alias: claude beats claude-contrib although the joined path would sort the other way', () => {
    assertOwners([
      { session: 'S-a', ts: T0, files: [{ alias: 'claude-contrib', rel_path: 'a/x.jsonl', first: T0 }] },
      { session: 'S-b', ts: T0, files: [{ alias: 'claude', rel_path: 'z/x.jsonl', first: T0 }] },
    ], ['S-b', ''], ['S-a', '']);
  });

  it('then rel_path bytewise (uppercase sorts first)', () => {
    assertOwners([
      { session: 'S-a', ts: T0, files: [{ rel_path: 'p/a.jsonl', first: T0 }] },
      { session: 'S-b', ts: T0, files: [{ rel_path: 'p/B.jsonl', first: T0 }] },
    ], ['S-b', ''], ['S-a', '']);
  });

  it('then session_id, then agent_id, when every file term ties', () => {
    const f = [{ rel_path: 'p/same.jsonl', first: T0 }];
    assertOwners([{ session: 'S-b', ts: T0, files: f }, { session: 'S-a', ts: T0, files: f }], ['S-a', ''], ['S-b', '']);
    assertOwners([{ session: 'S-a', agent: 'agent-b', ts: T0, files: f }, { session: 'S-a', agent: 'agent-a', ts: T0, files: f }], ['S-a', 'agent-a'], ['S-a', 'agent-b']);
  });

  it('an occurrence with no file row sorts after one with a file when everything earlier ties', () => {
    assertOwners([{ session: 'S-a', ts: T0 }, { session: 'S-b', ts: T0, files: [{ rel_path: 'p/b.jsonl', first: T0 }] }], ['S-b', ''], ['S-b', '']);
  });
});

describe('dedup SELECT columns and tokens', () => {
  const tokensOf = (rows, rule) => {
    const ctx = store(rows);
    try {
      const r = select(ctx, rule).find((x) => x.message_id === 'm1');
      assert.ok(r, 'message m1 selected');
      return [r.input_tokens, r.output_tokens, r.cache_read, r.cache_creation, r.cache_5m, r.cache_1h];
    } finally {
      ctx.cleanup();
    }
  };

  it('takes the field-wise maximum over all occurrences whatever the owner rule', () => {
    const rows = [{ session: 'S-a', ts: T0, tokens: [5, 7, 0, 0, 0, 0] }, { session: 'S-b', ts: T1, tokens: [5, 25, 0, 0, 0, 0] }];
    assert.deepEqual(tokensOf(rows, 'earliest'), [5, 25, 0, 0, 0, 0]);
    assert.deepEqual(tokensOf(rows, 'latest'), [5, 25, 0, 0, 0, 0]);
  });

  it('a NULL in one occurrence and a number in another yields the number; all NULL stays NULL', () => {
    const rows = [{ session: 'S-a', ts: T0, tokens: [null, 3, null, 1, null, null] }, { session: 'S-b', ts: T1, tokens: [4, null, null, 2, null, null] }];
    assert.deepEqual(tokensOf(rows, 'earliest'), [4, 3, null, 2, null, null]);
  });

  it('a synthetic occurrence never contributes tokens, is never the owner and is not counted', () => {
    const ctx = store([
      { session: 'S-syn', ts: '2026-10-27T09:00:00.000Z', model: '<synthetic>', tokens: [999, 999, 999, 999, 999, 999] },
      { session: 'S-a', ts: T0, tokens: [1, 2, 3, 4, 4, 0] },
    ]);
    try {
      const rows = select(ctx, 'earliest');
      assert.equal(rows.length, 1);
      const r = rows[0];
      assert.deepEqual([r.owner_session_id, r.occurrences, r.input_tokens, r.output_tokens], ['S-a', 1, 1, 2]);
    } finally {
      ctx.cleanup();
    }
  });

  it('a message seen only as synthetic yields no row, while a NULL model is kept', () => {
    const ctx = store([
      { message: 'm-syn', session: 'S-a', ts: T0, model: '<synthetic>' },
      { message: 'm1', session: 'S-a', ts: T0, model: null },
    ]);
    try {
      const rows = select(ctx, 'earliest');
      assert.deepEqual(rows.map((r) => [r.message_id, r.model]), [['m1', null]]);
    } finally {
      ctx.cleanup();
    }
  });

  it('returns the owner identity columns, the occurrence count and the meta agent type of the owner', () => {
    const ctx = store([
      { session: 'S-a', agent: 'agent-x', ts: T0, attribution: 'fork', request: 'req-1', effort: 'high', files: [{ rel_path: 'p/x.jsonl', first: T0 }] },
      { session: 'S-a', agent: 'agent-y', ts: T1, attribution: 'general-purpose', request: 'req-1', effort: 'low', files: [{ rel_path: 'p/y.jsonl', first: T1 }] },
    ]);
    try {
      const db = openTempStore({ home: ctx.home });
      try {
        insertMeta(db, { session_id: 'S-a', agent_id: 'agent-x', agent_type: 'general-purpose' });
        insertMeta(db, { session_id: 'S-a', agent_id: 'agent-y', agent_type: 'Explore' });
      } finally {
        db.close();
      }
      const r = select(ctx, 'earliest')[0];
      assert.ok(r, 'one owner row');
      assert.deepEqual(
        [r.message_id, r.owner_session_id, r.owner_agent_id, r.occurrences, r.request_id, r.ts_utc, r.model, r.attribution_agent, r.effort, r.meta_agent_type],
        ['m1', 'S-a', 'agent-x', 2, 'req-1', T0, 'claude-opus-5-5', 'fork', 'high', 'general-purpose'],
      );
      const l = select(ctx, 'latest')[0];
      assert.deepEqual([l.owner_agent_id, l.attribution_agent, l.effort, l.meta_agent_type], ['agent-y', 'general-purpose', 'low', 'Explore']);
    } finally {
      ctx.cleanup();
    }
  });

  it('has_iterations is the maximum over occurrences, so the owner choice cannot drop the advisor parts', () => {
    const ctx = store([{ session: 'S-a', ts: T0, hasIterations: 0 }, { session: 'S-b', ts: T1, hasIterations: 1 }]);
    try {
      const db = openTempStore({ home: ctx.home });
      try {
        insertIter(db, { session_id: 'S-b', message_id: 'm1', iter_seq: 0, iter_type: 'advisor_message', model: 'a', input_tokens: 1 });
      } finally {
        db.close();
      }
      assert.equal(select(ctx, 'earliest')[0]?.has_iterations, 1);
      assert.equal(select(ctx, 'latest')[0]?.has_iterations, 1);
    } finally {
      ctx.cleanup();
    }
  });

  // Review CR-01 (RR-04): an unknown copy may hide a server-tool count above 0, so a 0 from another copy of the
  // same message cannot answer for it; a 1 from any copy wins; synthetic copies take no part.
  it('has_server_tool_use over copies: any 1 gives 1, else any NULL gives NULL, else 0, under both rules', () => {
    const flagOf = (stus, extra = []) => {
      const ctx = store([...stus.map((stu, i) => ({ session: `S-${i}`, ts: i ? T1 : T0, stu })), ...extra]);
      try {
        const got = ['earliest', 'latest'].map((rule) => select(ctx, rule).find((r) => r.message_id === 'm1')?.has_server_tool_use);
        assert.equal(got[0], got[1], 'both owner rules agree');
        return got[0];
      } finally {
        ctx.cleanup();
      }
    };
    assert.equal(flagOf([0, null]), null, 'a 0 beside an unknown is unknown');
    assert.equal(flagOf([null, 0]), null, 'an unknown beside a 0 is unknown');
    assert.equal(flagOf([1, null]), 1);
    assert.equal(flagOf([null, 1]), 1);
    assert.equal(flagOf([0, 1]), 1);
    assert.equal(flagOf([0, 0]), 0);
    assert.equal(flagOf([null, null]), null);
    assert.equal(flagOf([0], [{ session: 'S-syn', ts: T1, model: '<synthetic>', stu: null }]), 0, 'a synthetic copy takes no part');
  });

  it('the SELECT binds no user text: the rule name only chooses among fixed strings', () => {
    const text = readFileSync(new URL('../../src/derive/owner.mjs', import.meta.url), 'utf8');
    assert.ok(text.includes('unixepoch('), 'the owner terms use unixepoch');
    assert.ok(!/\$\{\s*name\s*\}/.test(text), 'the rule name is never interpolated');
  });
});

describe('store level: ts_utc keeps the earliest line time', () => {
  it('a streamed message ingested with its lines in reverse order keeps the earliest line time', async () => {
    const ctx = makeHome();
    try {
      const h = HELPERS;
      const file = join(ctx.root, 'projects', `${h.mangleHome(ctx.home)}-repos-rev`, 'sess-rev.jsonl');
      const line = (ts, output) => JSON.stringify(h.makeAssistant({
        session: 'sess-rev', ts, id: 'msg_rev', model: 'claude-haiku-5-5', use: h.makeUsage({ input: 1, output, read: 1, creation: 1 }),
      }));
      h.writeJsonl(file, [line('2026-10-27T11:00:03.000Z', 9), line('2026-10-27T11:00:02.000Z', 5), line('2026-10-27T11:00:01.000Z', 3)]);
      const { runIngest } = await mod('ingest/run.mjs');
      await runIngest({ home: ctx.home, env: { HOME: ctx.home }, windowsUsersDir: windowsUsersDirFor(ctx.home) });
      const rows = queryDb(join(stateDirOf(ctx.home), 'store.db'), 'SELECT ts_utc, output_tokens FROM cc_message');
      assert.deepEqual(rows, [{ ts_utc: '2026-10-27T11:00:01.000Z', output_tokens: 9 }]);
    } finally {
      ctx.cleanup();
    }
  });
});
