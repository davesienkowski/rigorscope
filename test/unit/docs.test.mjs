// D-16: documentation ships with the code and a failing test notices when docs and CLI drift.
// Checks README.md and docs/*.md against the CLI (documented commands and flags must exist, every
// option must be documented), against the database tables and columns, against the normalizer
// allowlist, and for ASCII, identity and absolute-path hygiene.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { makeHome, buildTranscriptTree, queryDb, stateDirOf } from '../fixtures/build.mjs';
import { holdsUserName } from '../helpers/docs-checks.mjs';

const REPO = new URL('../../', import.meta.url).pathname;
const DOC_FILES = ['README.md', 'docs/cli.md', 'docs/data-model.md', 'docs/sources.md', 'docs/privacy.md', 'docs/operations.md', 'docs/units.md', 'docs/architecture.md', 'docs/getting-started.md', 'docs/known-limits.md'];
// The one place the account name may appear: the clone URL that package.json names (plan 09-06 writes it).
const cloneUrl = () => JSON.parse(read('package.json')).repository?.url ?? null;
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);

const commandNames = () => readdirSync(join(REPO, 'src/commands'))
  .filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).sort();

async function commandOptions() {
  const out = {};
  for (const name of commandNames()) out[name] = Object.keys((await mod(`commands/${name}.mjs`)).options);
  return out;
}

describe('documentation files', () => {
  it('README.md and the six docs pages exist and are pure ASCII (no byte above 127, no em dash)', () => {
    for (const f of DOC_FILES) {
      assert.ok(existsSync(join(REPO, f)), `${f} exists`);
      const buf = readFileSync(join(REPO, f));
      const bad = [...buf].findIndex((b) => b > 127);
      assert.equal(bad, -1, `${f} has a non-ASCII byte at offset ${bad}`);
    }
  });

  it('none contains the OS user name, an absolute home path or an email-shaped string', () => {
    const user = userInfo().username;
    const checkUser = user.length >= 3 && !['root', 'runner', 'ubuntu', 'user'].includes(user.toLowerCase());
    const homePath = /(?:^|[\s`'"(=:])(?:\/home\/|\/Users\/|\/mnt\/[a-z]\/Users\/|[A-Za-z]:[\\/])/m;
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
    for (const f of DOC_FILES) {
      const text = read(f);
      if (checkUser) assert.ok(!holdsUserName({ text, user, cloneUrl: cloneUrl() }), `${f} holds the OS user name`);
      assert.ok(!homePath.test(text), `${f} holds an absolute home path`);
      assert.ok(!email.test(text), `${f} holds an email-shaped string`);
    }
  });

  it('every "$ rigorscope ..." and "$ node bin/rigorscope.mjs ..." example names a real command and only its flags', async () => {
    const options = await commandOptions();
    let seen = 0;
    for (const f of DOC_FILES) {
      for (const raw of read(f).split('\n')) {
        const m = /^\s*\$\s+(?:rigorscope|node bin\/rigorscope\.mjs)\s*(.*)$/.exec(raw);
        if (!m) continue;
        seen += 1;
        const tokens = m[1].trim().split(/\s+/).filter(Boolean);
        const cmd = tokens.find((t) => !t.startsWith('-'));
        const flags = tokens.filter((t) => t.startsWith('-')).map((t) => t.replace(/=.*$/, ''));
        if (cmd === undefined) {
          for (const flag of flags) assert.ok(['--help', '-h'].includes(flag), `${f}: ${raw.trim()}`);
          continue;
        }
        assert.ok(Object.hasOwn(options, cmd), `${f}: unknown command in "${raw.trim()}"`);
        const allowed = new Set([...options[cmd].map((o) => `--${o}`), '--help', '-h']);
        for (const flag of flags) assert.ok(allowed.has(flag), `${f}: flag ${flag} is not an option of ${cmd}`);
      }
    }
    assert.ok(seen >= 2, 'the docs contain runnable examples');
  });
});

describe('docs/cli.md', () => {
  it('has a "### command" heading for every command file and none for a missing command', () => {
    const headings = [...read('docs/cli.md').matchAll(/^### ([a-z][a-z-]*)\s*$/gm)].map((m) => m[1]).sort();
    assert.deepEqual(headings, commandNames());
  });

  it('documents every option each command declares under that command, plus --help and the exit codes', async () => {
    const text = read('docs/cli.md');
    const options = await commandOptions();
    for (const [cmd, flags] of Object.entries(options)) {
      const start = text.indexOf(`### ${cmd}`);
      assert.ok(start >= 0, `section for ${cmd}`);
      const next = text.slice(start + 4).search(/^#{2,3} /m);
      const section = next < 0 ? text.slice(start) : text.slice(start, start + 4 + next);
      for (const flag of flags) assert.ok(section.includes(`--${flag}`), `--${flag} documented under ${cmd}`);
    }
    assert.ok(text.includes('--help'));
    for (const code of ['0', '1', '2']) assert.match(text, new RegExp(`\\b${code}\\b`));
  });
});

describe('docs/data-model.md and docs/sources.md', () => {
  const homes = [];
  after(() => homes.forEach((c) => c.cleanup()));

  it('names every table and column of a fresh store.db and derived.db, and all seven labels', async () => {
    const ctx = makeHome();
    homes.push(ctx);
    buildTranscriptTree(ctx.root);
    const { runIngest } = await mod('ingest/run.mjs');
    const { rebuildDerived } = await mod('derive/rebuild.mjs');
    const { LABELS } = await mod('measure/measure.mjs');
    await runIngest({ home: ctx.home, root: ctx.root });
    rebuildDerived({ home: ctx.home });
    const text = read('docs/data-model.md');
    const names = new Set();
    for (const file of ['store.db', 'derived.db']) {
      const db = join(stateDirOf(ctx.home), file);
      for (const t of queryDb(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
        names.add(t.name);
        for (const c of queryDb(db, `PRAGMA table_info(${t.name})`)) names.add(c.name);
      }
    }
    assert.ok(names.size > 20);
    for (const name of names) assert.ok(text.includes(`\`${name}\``), `data-model.md names \`${name}\` in backticks`);
    assert.equal(LABELS.length, 7);
    for (const label of LABELS) assert.ok(text.includes(`\`${label}\``), `label ${label}`);
  });

  // Plan 01-06: the usage pick tables of the cache file and of transcript usageReport lines.
  it('docs/sources.md names every CACHE_PICK and REPORT_PICK path and column', async () => {
    const { CACHE_PICK } = await mod('sources/usage/cache.mjs');
    const { REPORT_PICK } = await mod('sources/usage/report.mjs');
    const text = read('docs/sources.md');
    for (const e of [...CACHE_PICK, ...REPORT_PICK]) {
      assert.ok(text.includes(`\`${e.path}\``), `path ${e.path}`);
      assert.ok(text.includes(`\`${e.column}\``), `column ${e.column}`);
    }
  });

  it('docs/sources.md names every allowlisted source path and column', async () => {
    const { ALLOWLIST } = await mod('sources/transcript/normalize.mjs');
    const text = read('docs/sources.md');
    for (const e of ALLOWLIST) {
      assert.ok(text.includes(`\`${e.source}\``), `source ${e.source}`);
      assert.ok(text.includes(`\`${e.column}\``), `column ${e.column}`);
    }
  });
});

describe('docs/privacy.md and README.md', () => {
  it('privacy.md names the canary test file, the leaking-stub self-test and the metadata-only rule', () => {
    const text = read('docs/privacy.md');
    assert.ok(text.includes('test/canary/canary.test.mjs'));
    assert.ok(text.includes('test/canary/leaky-normalizer.mjs'));
    assert.match(text, /self-test/i);
    assert.match(text, /metadata/i);
  });

  it('README.md links known-limits and names npm run demo, npm link, git clone, the 24.15 floor, the quick start and links the four docs', () => {
    const text = read('README.md');
    assert.ok(!text.includes('no code yet'), 'the old status line is gone');
    assert.ok(text.includes('docs/known-limits.md'), 'README links Known limits');
    assert.ok(text.includes('npm run demo'));
    assert.ok(text.includes('git clone'));
    assert.ok(text.includes('npm link'));
    assert.ok(text.includes('24.15'));
    assert.match(text, /Quick start/i);
    for (const doc of ['docs/cli.md', 'docs/data-model.md', 'docs/sources.md', 'docs/privacy.md']) {
      assert.ok(text.includes(`](${doc})`), `README links ${doc}`);
    }
    for (const dir of ['bin/', 'src/', 'test/', 'docs/']) assert.ok(text.includes(dir), `layout names ${dir}`);
  });
});
