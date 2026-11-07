// Source auto-discovery and descriptor validation (src/ingest/sources.mjs), plus the proof that the
// runner holds no transcript-specific code: a stub source in a temporary directory runs end to end.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHome, queryDb, stateDirOf } from '../fixtures/build.mjs';

const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const scratch = () => mkdtempSync(join(tmpdir(), 'rigorscope-src-'));
const fnStub = 'async function* () {}';

function writeSource(dir, name, body) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'index.mjs'), body);
}
const descriptor = (name, over = {}) => `
export const name = ${JSON.stringify(name)};
export const freshness = ${over.freshness ?? '{ live: true, staleAfterHours: 36 }'};
export const discover = ${over.discover ?? fnStub.replace('async function*', 'async function')};
export const read = ${over.read ?? fnStub};
export const normalize = ${over.normalize ?? '() => ({ records: [] })'};
export const createWriter = ${over.createWriter ?? '() => ({ write: () => 0 })'};
`;

describe('loadSources and validateDescriptor', () => {
  it('lists the real sources sorted by name, each with a valid descriptor, transcript included', async () => {
    const { loadSources, SOURCES_DIR } = await mod('ingest/sources.mjs');
    assert.equal(typeof SOURCES_DIR, 'string');
    const list = await loadSources({ dir: SOURCES_DIR });
    const names = list.map((s) => s.name);
    assert.ok(names.includes('transcript'));
    assert.deepEqual(names, [...names].sort());
    const t = list.find((s) => s.name === 'transcript');
    assert.deepEqual({ ...t.freshness }, { live: true, staleAfterHours: 36 });
    for (const f of ['discover', 'read', 'normalize', 'createWriter']) assert.equal(typeof t[f], 'function', f);
  });

  it('validateDescriptor names the offending directory for a wrong name, a bad freshness and a missing function', async () => {
    const { validateDescriptor } = await mod('ingest/sources.mjs');
    const good = { name: 'abc', freshness: { live: true, staleAfterHours: 1 }, discover() {}, read() {}, normalize() {}, createWriter() {} };
    assert.doesNotThrow(() => validateDescriptor(good, 'abc'));
    assert.throws(() => validateDescriptor({ ...good, name: 'other' }, 'abc'), /abc/);
    assert.throws(() => validateDescriptor({ ...good, freshness: { live: 'yes' } }, 'abc'), /abc/);
    assert.throws(() => validateDescriptor({ ...good, normalize: undefined }, 'abc'), /abc/);
    assert.throws(() => validateDescriptor({ ...good, name: 'Bad Name' }, 'Bad Name'), /Bad Name/);
  });

  it('picks up a source added in a directory with no edit to a shared file, sorted, ignoring directories without index.mjs', async () => {
    const { loadSources } = await mod('ingest/sources.mjs');
    const dir = scratch();
    try {
      writeSource(dir, 'zeta', descriptor('zeta'));
      writeSource(dir, 'alpha', descriptor('alpha'));
      mkdirSync(join(dir, 'empty-dir'));
      assert.deepEqual((await loadSources({ dir })).map((s) => s.name), ['alpha', 'zeta']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws naming the offending directory when one descriptor is invalid', async () => {
    const { loadSources } = await mod('ingest/sources.mjs');
    const dir = scratch();
    try {
      writeSource(dir, 'good', descriptor('good'));
      writeSource(dir, 'broken', descriptor('broken', { freshness: '{ live: 1 }' }));
      await assert.rejects(loadSources({ dir }), /broken/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the runner is source-agnostic', () => {
  it('runs a stub source from a temporary sources directory with no runner change, recording its progress and cursor', async () => {
    const { runIngest } = await mod('ingest/run.mjs');
    const ctx = makeHome();
    const dir = scratch();
    const data = join(ctx.home, 'stubdata');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'a.txt'), 'alpha\nbeta\n');
    try {
      writeSource(dir, 'stub', `
import { readFileSync } from 'node:fs';
export const name = 'stub';
export const freshness = { live: false, staleAfterHours: 24 };
export async function discover() {
  return { roots: [{ alias: 'stubroot', display: 'stubroot', kind: 'stub' }], units: [{ rootAlias: 'stubroot', rel: 'a.txt', abs: ${JSON.stringify(join(data, 'a.txt'))}, kind: 'session' }] };
}
export async function* read(unit, start) {
  const text = readFileSync(unit.abs, 'latin1');
  let pos = 0;
  for (const part of text.split('\\n')) {
    if (part === '') break;
    pos += part.length + 1;
    if (pos > start) yield { text: part, end: pos };
  }
}
export function normalize(item) { return { records: [{ kind: 'row', text: item.text }] }; }
export function createWriter(db) {
  db.exec('CREATE TABLE IF NOT EXISTS stub_rows (text TEXT PRIMARY KEY) STRICT');
  const ins = db.prepare('INSERT OR IGNORE INTO stub_rows (text) VALUES (?)');
  return { write: (rec) => { ins.run(rec.text); return 1; } };
}
`);
      const s = await runIngest({ home: ctx.home, env: {}, windowsUsersDir: '', sourcesDir: dir });
      assert.ok(s, 'summary returned');
      const q = (sql) => queryDb(join(stateDirOf(ctx.home), 'store.db'), sql);
      assert.deepEqual(q('SELECT text FROM stub_rows ORDER BY text').map((r) => r.text), ['alpha', 'beta']);
      const [sr] = q("SELECT * FROM ingest_source_run WHERE source = 'stub'");
      assert.equal(sr.files, 1);
      assert.equal(sr.rows_upserted, 2);
      const [f] = q('SELECT * FROM source_file');
      assert.equal(f.rel_path, 'a.txt');
      assert.equal(f.offset, 11);
      assert.equal(f.state, 'ok');
      // a second run reads nothing new
      await runIngest({ home: ctx.home, env: {}, windowsUsersDir: '', sourcesDir: dir });
      assert.equal(q("SELECT bytes_read AS b FROM ingest_source_run WHERE source = 'stub' ORDER BY run_id DESC LIMIT 1")[0].b, 0);
      assert.equal(q('SELECT count(*) AS n FROM stub_rows')[0].n, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      ctx.cleanup();
    }
  });

  it('src/ingest/run.mjs contains no transcript-specific code', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../../src/ingest/run.mjs', import.meta.url), 'utf8');
    assert.ok(!/transcript/i.test(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'no reference to the transcript source outside comments');
    for (const needle of ['loadSources', 'decideStart', 'withLock']) assert.ok(text.includes(needle), needle);
  });
});
