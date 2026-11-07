// Plan 02-03 (D-05, D-06): the versioned risk-rule table data/risk-rules-YYYY-MM-DD.json, its strict loader
// src/units/risk-rules.mjs (the price-table pattern) and the pure risk rules of src/units/risk.mjs. Written before the
// code (RED): the modules are loaded inside the tests that use them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SHIPPED = 'data/risk-rules-2026-10-30.json';
const rulesMod = () => import('../../src/units/risk-rules.mjs');
const riskMod = () => import('../../src/units/risk.mjs');
const VOCAB = ['gate-or-hook', 'security', 'parser', 'global-config', 'script', 'docs'];

// A small valid table for the loader cases (not the shipped rules).
function validTable(version = '2026-10-30') {
  return {
    schema: 1,
    version,
    vocabulary: [...VOCAB],
    exclude_prefixes: ['.planning/'],
    rules: [
      { id: 'hook-dir', tag: 'gate-or-hook', match: '(^|\\/)hooks\\/', flags: 'i' },
      { id: 'script-ext', tag: 'script', match: '\\.(sh|mjs)$', flags: 'i', not: '\\.test\\.' },
    ],
    docs_only: { id: 'docs-only', tag: 'docs', match: '\\.(md|txt)$', flags: 'i' },
    script_unless: { id: 'script-unless-specific', tag: 'script', specific: ['gate-or-hook', 'security', 'parser', 'global-config'] },
    notes: 'test table',
  };
}

async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rigorscope-risk-rules-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const put = (dir, name, value) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));

async function expectCode(dir, code) {
  const { loadRiskRules, RiskRulesError } = await rulesMod();
  assert.throws(() => loadRiskRules({ dir }), (err) => {
    assert.ok(err instanceof RiskRulesError);
    assert.equal(err.code, code);
    assert.equal(err.message, `risk rules unusable: ${code}`);
    return true;
  });
}

describe('the shipped risk-rule table', () => {
  it('the shipped risk-rule table exists, is not ignored by git and is plain ASCII', () => {
    assert.ok(existsSync(join(REPO, SHIPPED)), 'the shipped risk-rule table exists');
    // A tree without .git (an archive copy, a published tarball) has no ignore rules to ask: the other checks still run.
    if (existsSync(join(REPO, '.git'))) {
      const ignored = spawnSync('git', ['-C', REPO, 'check-ignore', '-q', SHIPPED], { encoding: 'utf8' });
      assert.equal(ignored.status, 1, 'git check-ignore exits 1 (the table is not ignored)');
    }
    const bytes = readFileSync(join(REPO, SHIPPED));
    assert.equal([...bytes].findIndex((b) => b > 127), -1, 'the table is plain ASCII');
  });

  it('loads as version 2026-10-30 with the D-05 vocabulary, the six research rules and the sha of its bytes', async () => {
    const { loadRiskRules, RISK_RULES_FILE_RE, MAX_RISK_RULES_FILE_BYTES, RISK_RULES_ERROR_CODES } = await rulesMod();
    const t = loadRiskRules();
    assert.equal(t.version, '2026-10-30');
    assert.equal(t.file, 'risk-rules-2026-10-30.json');
    assert.deepEqual([...t.vocabulary], VOCAB);
    assert.deepEqual([...t.excludePrefixes], ['.planning/']);
    assert.deepEqual(t.rules.map((r) => r.id), ['gate-hook-dir', 'gate-hook-name', 'sec-push-cred', 'parser-name', 'global-config', 'script-ext']);
    assert.deepEqual(t.rules.map((r) => r.tag), ['gate-or-hook', 'gate-or-hook', 'security', 'parser', 'global-config', 'script']);
    assert.equal(t.docsOnly.id, 'docs-only');
    assert.equal(t.scriptUnless.id, 'script-unless-specific');
    assert.deepEqual([...t.scriptUnless.specific], ['gate-or-hook', 'security', 'parser', 'global-config']);
    assert.equal(t.sha, createHash('sha256').update(readFileSync(join(REPO, SHIPPED))).digest('hex'));
    assert.ok(RISK_RULES_FILE_RE.test('risk-rules-2026-10-30.json'));
    assert.ok(!RISK_RULES_FILE_RE.test('risk-rules-2026-10-30.json.bak'));
    assert.equal(MAX_RISK_RULES_FILE_BYTES, 65536);
    assert.deepEqual([...RISK_RULES_ERROR_CODES], ['bad_dir', 'no_rules_file', 'file_unreadable', 'file_too_large', 'bad_json', 'bad_schema', 'bad_rule', 'version_mismatch']);
    assert.ok(Object.isFrozen(t));
  });

  it('the shipped patterns are the research v1 sources, unchanged', async () => {
    const { loadRiskRules } = await rulesMod();
    const t = loadRiskRules();
    const src = Object.fromEntries(t.rules.map((r) => [r.id, [r.re.source, r.re.flags, r.not ? r.not.source : null]]));
    assert.deepEqual(src, {
      'gate-hook-dir': ['(^|\\/)(hooks|gates?)\\/', 'i', null],
      'gate-hook-name': ['(^|[\\/_-])(gate|guard|hook)s?([\\/_.-]|$)', 'i', '(compact-digest|digest\\.source)'],
      'sec-push-cred': ['(push|credential|secret|token|auth|redact|scrub|vetting|provenance|allowlist|isolation|permission)', 'i', null],
      'parser-name': ['(pars(e|er|ing)|lexer|tokeniz|normaliz|classif|frontmatter|discriminator|dedup)', 'i', null],
      'global-config': ['(\\$HOME\\/\\.claude\\/|~\\/\\.claude\\/|settings(\\.local)?\\.json$|managed-settings|\\$HOME\\/\\.gsd\\/|\\.wslconfig)', 'i', null],
      'script-ext': ['\\.(sh|mjs|cjs|js|py|ts)$', 'i', '(\\.test\\.|\\/tests?\\/|\\/fixtures?\\/)'],
    });
    assert.equal(t.docsOnly.re.source, '\\.(md|txt)$');
  });
});

describe('the loader refuses a bad table with a fixed code and no text from the file', () => {
  it('a later dated file wins', async () => {
    const { loadRiskRules } = await rulesMod();
    await withDir((dir) => {
      put(dir, 'risk-rules-2026-10-30.json', validTable('2026-10-30'));
      put(dir, 'risk-rules-2026-11-02.json', validTable('2026-11-02'));
      put(dir, 'risk-rules-notes.json', '{}');
      assert.equal(loadRiskRules({ dir }).version, '2026-11-02');
    });
  });

  it('a symlink, a directory named like the file, an oversized file and a byte above 127', async () => {
    await withDir(async (dir) => {
      put(dir, 'real.json', validTable());
      symlinkSync(join(dir, 'real.json'), join(dir, 'risk-rules-2026-10-30.json'));
      await expectCode(dir, 'file_unreadable');
    });
    await withDir(async (dir) => {
      mkdirSync(join(dir, 'risk-rules-2026-10-30.json'));
      await expectCode(dir, 'file_unreadable');
    });
    await withDir(async (dir) => {
      const t = validTable();
      t.notes = 'x'.repeat(65537);
      put(dir, 'risk-rules-2026-10-30.json', JSON.stringify(t));
      await expectCode(dir, 'file_too_large');
    });
    await withDir(async (dir) => {
      const t = validTable();
      t.notes = 'café secret-text';
      put(dir, 'risk-rules-2026-10-30.json', JSON.stringify(t));
      await expectCode(dir, 'bad_json');
    });
  });

  it('bad JSON, an extra key, a missing key and a bad vocabulary', async () => {
    const cases = [
      ['{"schema": 1, secret-text', 'bad_json'],
      [{ ...validTable(), extra: 'secret-text' }, 'bad_schema'],
      [(() => { const t = validTable(); delete t.notes; return t; })(), 'bad_schema'],
      [{ ...validTable(), vocabulary: [...VOCAB, 'other'] }, 'bad_schema'],
      [{ ...validTable(), schema: 2 }, 'bad_schema'],
      [(() => { const t = validTable(); t.rules[0].extra = 'x'; return t; })(), 'bad_rule'],
      [(() => { const t = validTable(); delete t.rules[0].flags; return t; })(), 'bad_rule'],
    ];
    for (const [value, code] of cases) {
      await withDir(async (dir) => {
        put(dir, 'risk-rules-2026-10-30.json', value);
        await expectCode(dir, code);
      });
    }
  });

  it('a tag outside the vocabulary, a duplicate id, a long or broken pattern, a flag other than i', async () => {
    const mutate = (fn) => { const t = validTable(); fn(t); return t; };
    const cases = [
      mutate((t) => { t.rules[0].tag = 'other'; }),
      mutate((t) => { t.rules[1].id = t.rules[0].id; }),
      mutate((t) => { t.docs_only.id = t.rules[0].id; }),
      mutate((t) => { t.rules[0].match = `(${'a'.repeat(199)})`; }),
      mutate((t) => { t.rules[0].match = '(unbalanced'; }),
      mutate((t) => { t.rules[1].not = '[broken'; }),
      mutate((t) => { t.rules[0].flags = 'g'; }),
      mutate((t) => { t.rules[0].flags = 'ig'; }),
      mutate((t) => { t.docs_only.tag = 'script'; }),
      mutate((t) => { t.script_unless.specific = ['other']; }),
    ];
    assert.equal(cases[3].rules[0].match.length, 201);
    for (const value of cases) {
      await withDir(async (dir) => {
        put(dir, 'risk-rules-2026-10-30.json', value);
        await expectCode(dir, 'bad_rule');
      });
    }
  });

  it('a version that differs from the file date, an empty directory and a relative directory', async () => {
    await withDir(async (dir) => {
      put(dir, 'risk-rules-2026-10-30.json', validTable('2026-10-31'));
      await expectCode(dir, 'version_mismatch');
    });
    await withDir(async (dir) => {
      await expectCode(dir, 'no_rules_file');
    });
    await expectCode('data', 'bad_dir');
  });
});

describe('risk tags (D-05, D-06)', () => {
  const V = '2026-10-30';
  const r = async (paths) => {
    const { riskOf } = await riskMod();
    const { loadRiskRules } = await rulesMod();
    return riskOf({ paths, source: 'files_modified' }, loadRiskRules());
  };

  it('path rules tag a path, first matching rule in table order', async () => {
    assert.deepEqual(await r(['hooks/x.mjs']), { risk_class: ['gate-or-hook'], risk_source: `rule:gate-hook-dir@${V}` });
    assert.deepEqual(await r(['scripts/a.mjs']), { risk_class: ['script'], risk_source: `rule:script-ext@${V}` });
    assert.deepEqual(await r(['~/.claude/settings.json']), { risk_class: ['global-config'], risk_source: `rule:global-config@${V}` });
  });

  it('script is dropped when a specific tag is present', async () => {
    assert.deepEqual(await r(['hooks/x.sh', 'scripts/a.mjs']), { risk_class: ['gate-or-hook'], risk_source: `rule:gate-hook-dir@${V}` });
  });

  it('docs only when every considered path is .md or .txt', async () => {
    assert.deepEqual(await r(['README.md', 'notes.txt']), { risk_class: ['docs'], risk_source: `rule:docs-only@${V}` });
    assert.deepEqual(await r(['README.md', 'src/a.mjs']), { risk_class: ['script'], risk_source: `rule:script-ext@${V}` });
    assert.deepEqual(await r(['README.md', '.planning/x/PLAN.mjs']), { risk_class: ['docs'], risk_source: `rule:docs-only@${V}` });
  });

  it('considered paths that match nothing give [] with none; .planning paths are not considered', async () => {
    assert.deepEqual(await r(['test/a.test.mjs']), { risk_class: [], risk_source: 'none' });
    assert.deepEqual(await r(['.planning/x/PLAN.md']), { risk_class: [], risk_source: 'none' });
  });

  it('a path matching two tags gives both, sorted, with aligned sources', async () => {
    assert.deepEqual(await r(['hooks/auth-check.mjs']), {
      risk_class: ['gate-or-hook', 'security'],
      risk_source: `rule:gate-hook-dir@${V},rule:sec-push-cred@${V}`,
    });
  });

  it('touchedPaths prefers files_modified, falls back to commit files, else source none and unknown risk', async () => {
    const { touchedPaths, riskOf, RISK_TAGS } = await riskMod();
    const { loadRiskRules } = await rulesMod();
    assert.deepEqual([...RISK_TAGS], VOCAB);
    const commits = [
      { sha: 'b', author_ms: 2, files: [{ path: 'src/b.mjs', status: 'A' }, { path: 'src/a.mjs', status: 'M' }] },
      { sha: 'a', author_ms: 1, files: [{ path: 'src/a.mjs', status: 'A' }] },
    ];
    assert.deepEqual(touchedPaths({ filesModified: ['x.mjs'], commits }), { paths: ['x.mjs'], source: 'files_modified' });
    assert.deepEqual(touchedPaths({ filesModified: [], commits }), { paths: ['src/a.mjs', 'src/b.mjs'], source: 'commits' });
    assert.deepEqual(touchedPaths({ filesModified: null, commits }), { paths: ['src/a.mjs', 'src/b.mjs'], source: 'commits' });
    for (const input of [{ filesModified: null, commits: null }, { filesModified: [], commits: [] }, { filesModified: null, commits: [{ sha: 'm', author_ms: 1, files: [] }] }]) {
      const t = touchedPaths(input);
      assert.equal(t.source, 'none');
      assert.deepEqual(riskOf(t, loadRiskRules()), { risk_class: null, risk_source: 'no-evidence' });
    }
  });

  // Review WR-03 (02-03 code review): the shipped table names `~/.claude/`, `$HOME/.claude/` and `$HOME/.gsd/` but not
  // `~/.gsd/`, and the collector writes an absolute path under HOME as `~/...`. The table stays verbatim; the matcher
  // reads `~/` and `$HOME/` as one prefix, so one location gets one set of tags however the PLAN spelled it.
  it('~/ and $HOME/ are the same prefix, and an absolute path under HOME normalizes to it (review WR-03)', async () => {
    const GC = { risk_class: ['global-config'], risk_source: `rule:global-config@${V}` };
    for (const p of ['~/.gsd/local-mods/x.sh', '$HOME/.gsd/local-mods/x.sh', '~/.claude/settings.json', '$HOME/.claude/settings.json']) {
      assert.deepEqual(await r([p]), GC, p);
    }
    const { normalizeTouchedPath } = await import('../../src/adapters/gsd-core/signals.mjs');
    const { buildHomeSet } = await import('../../src/sources/transcript/home.mjs');
    const home = join(tmpdir(), 'rigorscope-wr03-home');
    const n = normalizeTouchedPath(join(home, '.gsd', 'local-mods', 'x.sh'), { top: join(tmpdir(), 'rigorscope-wr03-repo'), homeSet: buildHomeSet({ home }) });
    assert.deepEqual(n, { path: '~/.gsd/local-mods/x.sh' });
    assert.deepEqual(await r([n.path]), GC);
    assert.deepEqual(await r(['~/.gsd/local-mods/hooks/g.mjs']), await r(['$HOME/.gsd/local-mods/hooks/g.mjs']));
    assert.deepEqual(await r(['docs/~/.gsd/x.sh']), { risk_class: ['script'], risk_source: `rule:script-ext@${V}` }, 'only a leading prefix is read as home');
  });
});
