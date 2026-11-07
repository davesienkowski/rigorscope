// DATA-05 canary: plant identity and content values in every position the sources carry them, run
// the real path, and scan the RAW BYTES of the databases (main file, WAL and shared-memory files)
// and of all captured command output. A leaking stub normalizer proves the scan can fail; since plan 02-04 a leaking
// planning-ref extractor (test/canary/leaky-refs.mjs) proves it also for tool input text reaching cc_message_ref.
//
// Failure messages report source labels, needle names and byte offsets only. A planted value is
// never printed.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PLANTS, NON_ASCII_ESCAPED, makeHome, buildTranscriptTree, storeDigest, stateDirOf, caseContext,
  windowsUsersDirFor,
} from '../fixtures/build.mjs';
import { leakyNormalize } from './leaky-normalizer.mjs';
import { leakyExtractRefs } from './leaky-refs.mjs';
import { ALLOWLIST } from '../../src/sources/transcript/normalize.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);

const NEEDLES = Object.entries({ ...PLANTS, nonAsciiEscaped: NON_ASCII_ESCAPED });

// Plant modules (test/canary/plants/*.mjs): { id, source, plant(ctx) -> { needles } } write extra
// planted values into ctx.root and return the strings to scan for beyond every PLANTS value.
// Scenario modules (test/canary/scenarios/*.mjs): { id, run(ctx) -> { commands, outputs } } run the real
// path; every command is { args, status } and must exit 0 (a failing scenario scans nothing);
// outputs are { label, buf } captured bytes. Both directories are listed at load time, so adding a
// module needs no edit to this file.
const CANARY_DIR = fileURLToPath(new URL('./', import.meta.url));
async function loadModules(sub) {
  const dir = join(CANARY_DIR, sub);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort();
  return Promise.all(names.map((n) => import(pathToFileURL(join(dir, n)).href)));
}
const plantModules = await loadModules('plants');
const scenarioModules = await loadModules('scenarios');
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

// ASCII-only lowercase copy, so the OS user name matches case-insensitively without touching other bytes.
function asciiLower(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i += 1) if (out[i] >= 0x41 && out[i] <= 0x5a) out[i] += 0x20;
  return out;
}

// sources: [{ label, buf }]. Returns findings holding labels, needle names and offsets only.
function scan(sources, extra = []) {
  const findings = [];
  const needles = [...NEEDLES, ...extra.map((v, i) => [`plant-${i}`, v])];
  for (const { label, buf } of sources) {
    const lower = asciiLower(buf);
    for (const [name, value] of needles) {
      const at = lower.indexOf(asciiLower(Buffer.from(value, 'utf8')));
      if (at >= 0) findings.push({ source: label, needle: name, offset: at });
    }
    const m = EMAIL_SHAPE.exec(buf.toString('latin1'));
    if (m) findings.push({ source: label, needle: 'email-shape', offset: m.index });
  }
  return findings;
}

function dbSources(home, { derived = true } = {}) {
  const dir = stateDirOf(home);
  const names = ['store.db', 'store.db-wal', 'store.db-shm', ...(derived ? ['derived.db'] : [])];
  return names
    .filter((n) => existsSync(join(dir, n)))
    .map((n) => ({ label: n, buf: readFileSync(join(dir, n)) }));
}

describe('canary self-test: the scan has teeth', () => {
  let ctx;
  before(() => {
    ctx = makeHome();
    buildTranscriptTree(ctx.root);
  });
  after(() => ctx.cleanup());

  it('finds the prompt, command and OS user name plants when a leaking normalizer is injected', async () => {
    const { runIngest } = await mod('ingest/run.mjs');
    const { checkpointStore } = await mod('db.mjs');
    await runIngest({ home: ctx.home, root: ctx.root, normalize: leakyNormalize });
    checkpointStore({ home: ctx.home });
    const findings = scan(dbSources(ctx.home, { derived: false }));
    const names = new Set(findings.map((f) => f.needle));
    assert.ok(names.has('prompt'), 'prompt plant found in the leaking run');
    assert.ok(names.has('command'), 'command plant found in the leaking run');
    assert.ok(names.has('osUser'), 'OS user name plant found in the leaking run');
    assert.ok(names.has('nonAscii'), 'non-ASCII plant found in decoded form');
    assert.ok(names.has('email-shape') || names.has('email'), 'email plant found');
  });
});

describe('canary self-test: planning refs', () => {
  it('finds the Bash-string plant when a leaking ref extractor is injected', async () => {
    const ctx = makeHome();
    try {
      const refsPlant = plantModules.find((p) => p.id === 'refs');
      assert.ok(refsPlant, 'the refs plant module is listed');
      refsPlant.plant(caseContext(ctx.root, { home: ctx.home }));
      const { runIngest } = await mod('ingest/run.mjs');
      const { checkpointStore } = await mod('db.mjs');
      await runIngest({
        home: ctx.home, env: { HOME: ctx.home }, windowsUsersDir: windowsUsersDirFor(ctx.home), extractRefs: leakyExtractRefs,
      });
      checkpointStore({ home: ctx.home });
      const names = new Set(scan(dbSources(ctx.home, { derived: false }), ['CANARYbashref']).map((f) => f.needle));
      assert.ok(names.has('plant-0'), 'the Bash-string plant is found in the leaking run');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('canary: plant modules have teeth', () => {
  it('there is at least one plant module and one scenario module', () => {
    assert.ok(plantModules.length >= 1, 'plants listed');
    assert.ok(scenarioModules.length >= 2, 'scenarios listed');
  });

  for (const plant of plantModules) {
    it(`plant ${plant.id} returns needles and the scan reports each of them`, () => {
      const ctx = makeHome();
      try {
        const { needles } = plant.plant({ ...caseContext(ctx.root, { home: ctx.home }) });
        assert.ok(Array.isArray(needles) && needles.length > 0, 'a plant that returns no needles checks nothing');
        for (const needle of needles) {
          const findings = scan([{ label: 'synthetic', buf: Buffer.from(`xx ${needle} yy`, 'utf8') }], [needle]);
          assert.ok(findings.some((f) => f.needle.startsWith('plant-')), 'the scan finds the needle');
        }
      } finally {
        ctx.cleanup();
      }
    });
  }
});

for (const scenario of scenarioModules) {
  describe(`canary scenario ${scenario.id}: the real path leaks nothing`, () => {
    let ctx;
    let needles;
    let first;
    before(async () => {
      ctx = makeHome();
      needles = [];
      const pctx = caseContext(ctx.root, { home: ctx.home });
      for (const plant of plantModules) needles.push(...plant.plant(pctx).needles);
      first = await scenario.run({ ...pctx, runId: 1 });
      const { checkpointStore } = await mod('db.mjs');
      checkpointStore({ home: ctx.home });
    });
    after(() => ctx.cleanup());

    it('every scenario command exited 0', () => {
      assert.ok(first.commands.length >= 2, 'the scenario ran commands');
      for (const c of first.commands) assert.equal(c.status, 0, `${c.args[0]} exit status`);
    });

    it('finds none of the planted values in store.db, its WAL and shm files, derived.db or any output', () => {
      const findings = scan([...dbSources(ctx.home), ...first.outputs], needles);
      assert.deepEqual(findings, []);
    });

    it('is still clean after a second run, and the store digest is unchanged', async () => {
      const before = storeDigest(ctx.home);
      const pctx = caseContext(ctx.root, { home: ctx.home });
      const again = await scenario.run({ ...pctx, runId: 2 });
      for (const c of again.commands) assert.equal(c.status, 0, `${c.args[0]} exit status (second run)`);
      const { checkpointStore } = await mod('db.mjs');
      checkpointStore({ home: ctx.home });
      assert.deepEqual(scan([...dbSources(ctx.home), ...again.outputs], needles), []);
      assert.deepEqual(storeDigest(ctx.home), before);
    });
  });
}

describe('canary: interrupted and resumed ingest', () => {
  it('an ingest cut between chunks and then resumed leaves none of the planted values in any byte', async () => {
    const ctx = makeHome();
    try {
      const pctx = caseContext(ctx.root, { home: ctx.home });
      const needles = [];
      for (const plant of plantModules) needles.push(...plant.plant(pctx).needles);
      buildTranscriptTree(ctx.root);
      const { runIngest } = await mod('ingest/run.mjs');
      const { checkpointStore } = await mod('db.mjs');
      const env = { HOME: ctx.home };
      let chunks = 0;
      await assert.rejects(runIngest({
        home: ctx.home, env, windowsUsersDir: windowsUsersDirFor(ctx.home), chunkLines: 2,
        beforeCommit: () => { chunks += 1; if (chunks === 2) throw new Error('interrupt-here'); },
      }), /interrupt-here/);
      await runIngest({ home: ctx.home, env, windowsUsersDir: windowsUsersDirFor(ctx.home) });
      checkpointStore({ home: ctx.home });
      assert.deepEqual(scan(dbSources(ctx.home), needles), []);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('canary: schema', () => {
  let ctx;
  before(async () => {
    ctx = makeHome();
    buildTranscriptTree(ctx.root);
    const { runIngest } = await mod('ingest/run.mjs');
    await runIngest({ home: ctx.home, root: ctx.root });
  });
  after(() => ctx.cleanup());

  it('stored cc_message columns equal the allowlist columns, so a new field needs an allowlist entry', async () => {
    const { openStoreReadOnly } = await mod('db.mjs');
    const db = openStoreReadOnly({ home: ctx.home });
    try {
      const cols = new Set(db.prepare('PRAGMA table_info(cc_message)').all().map((r) => r.name));
      const allowed = new Set(ALLOWLIST.map((e) => e.column));
      assert.deepEqual([...cols].sort(), [...allowed].sort());
    } finally {
      db.close();
    }
  });

  it('keeps no path or content column anywhere in the store schema; cwd exists only because it is home-normalized', async () => {
    const { openStoreReadOnly } = await mod('db.mjs');
    const db = openStoreReadOnly({ home: ctx.home });
    try {
      const names = [];
      for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
        for (const c of db.prepare(`PRAGMA table_info(${t.name})`).all()) names.push(c.name);
      }
      // cwd is allowed since migration 002: it is stored only after home-prefix normalization, and the
      // plants of the discovery scenario put the OS user name in all four cwd forms to prove it.
      for (const n of names) assert.ok(!/^(path|file_path|source_path|abs_path|content|text|prompt|command|email)$/i.test(n), `column ${n}`);
    } finally {
      db.close();
    }
  });
});
