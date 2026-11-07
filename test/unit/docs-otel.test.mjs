// D-16 for plan 01-03: the documentation names what the OTel source and preserve-scrub built, taken
// from the code (the allowlist module exports, a fresh store) rather than from a second copy. The
// general drift checks (ASCII, identity, examples, every table and column) stay in docs.test.mjs.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, queryDb, stateDirOf } from '../fixtures/build.mjs';

const REPO = new URL('../../', import.meta.url).pathname;
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const mod = (rel) => import(new URL(`../../src/${rel}`, import.meta.url).href);
const section = (text, heading) => {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `heading ${heading}`);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return next < 0 ? text.slice(start) : text.slice(start, start + heading.length + next);
};
const tick = (s) => `\`${s}\``;

describe('docs/sources.md: OTel receiver files', () => {
  it('has the section and names both directories, both aliases, the override variable and the file name pattern', () => {
    const text = section(read('docs/sources.md'), '## OTel receiver files');
    for (const needle of ['~/.local/share/hook-telemetry', '~/.local/share/rigorscope/preserve/hook-telemetry', tick('live'), tick('preserve'),
      'HOOK_TELEMETRY_DIR', 'events-YYYY-MM-DD.jsonl', 'metrics-YYYY-MM-DD.jsonl', '--root']) {
      assert.ok(text.includes(needle), `sources.md names ${needle}`);
    }
  });

  it('names every event kind and every kept key of the allowlist, the header-only kinds and the header keys', async () => {
    const A = await mod('sources/otel/allowlist.mjs');
    const text = section(read('docs/sources.md'), '## OTel receiver files');
    for (const [kind, keys] of Object.entries(A.EVENT_ALLOW)) {
      assert.ok(text.includes(tick(kind)), `kind ${kind}`);
      for (const key of Object.keys(keys)) assert.ok(text.includes(tick(key)), `key ${kind}.${key}`);
    }
    for (const kind of A.HEADER_ONLY_KINDS) assert.ok(text.includes(tick(kind)), `header-only kind ${kind}`);
    for (const key of A.HEADER_KEYS) assert.ok(text.includes(tick(key)), `header key ${key}`);
  });

  it('names every metric attribute, every known metric, the shape kinds and every always-dropped key', async () => {
    const A = await mod('sources/otel/allowlist.mjs');
    const { SHAPE_KINDS } = await mod('redact/shapes.mjs');
    const text = section(read('docs/sources.md'), '## OTel receiver files');
    for (const key of Object.keys(A.METRIC_ALLOW)) assert.ok(text.includes(tick(key)), `metric attribute ${key}`);
    for (const m of A.KNOWN_METRICS) assert.ok(text.includes(tick(m)), `metric ${m}`);
    for (const k of SHAPE_KINDS) assert.ok(text.includes(tick(k)), `shape kind ${k}`);
    for (const k of [...A.SCRUB_FULL_KEYS, 'terminal.type', ...A.IDENTITY_PREFIXES.map((p) => `${p}*`), ...A.NOISE_RESOURCE_KEYS, 'service.version']) {
      assert.ok(text.includes(tick(k)), `dropped or kept key ${k}`);
    }
  });

  it('states the four-field event key, the metric ordinal and its residual, D-12, and the unknown token-bearing rule', () => {
    const text = section(read('docs/sources.md'), '## OTel receiver files');
    assert.match(text, /four[- ]field/i);
    assert.match(text, /ordinal/i);
    assert.match(text, /total_tokens/);
    assert.match(text, /hint/i);
    assert.match(text, /unknown token-bearing/i);
  });
});

describe('docs/data-model.md: OTel tables', () => {
  const homes = [];
  after(() => homes.forEach((c) => c.cleanup()));

  it('names the three tables, every column of a fresh store, the unknown_attr scopes and the ingest_count names this source uses', async () => {
    const ctx = makeHome();
    homes.push(ctx);
    const { openStore } = await mod('db.mjs');
    openStore({ home: ctx.home }).close();
    const text = section(read('docs/data-model.md'), '## OTel tables (migration 003)');
    for (const t of ['otel_event', 'otel_metric', 'otel_metric_line']) {
      assert.ok(text.includes(tick(t)), `table ${t}`);
      for (const c of queryDb(join(stateDirOf(ctx.home), 'store.db'), `PRAGMA table_info(${t})`)) assert.ok(text.includes(tick(c.name)), `column ${t}.${c.name}`);
    }
    for (const n of ['event_kind', 'metric_name', 'resource', 'walk_skip', 'rejected_field', 'unknown_token', 'key_conflict', 'header.event.name', 'dropped']) {
      assert.ok(text.includes(tick(n)), `name ${n}`);
    }
    assert.match(text, /json_extract/);
  });
});

describe('docs/cli.md, privacy.md, operations.md and README.md', () => {
  it('cli.md documents preserve-scrub: the flags, the dry-run default, both rule sets, the output lines and the exit codes', () => {
    const text = read('docs/cli.md');
    const s = section(`${text}\n## end`, '### preserve-scrub');
    for (const needle of ['--apply', '--full', 'dry run', 'tool_parameters', 'tool_input', 'error', 'prompt_text', 'vcs.ref.head.name', 'preserve-scrub: files=',
      'mode=dry-run', 'rules=default', 'no preserve directory']) {
      assert.ok(s.includes(needle), `preserve-scrub section names ${needle}`);
    }
    for (const code of ['0', '1', '2']) assert.match(s, new RegExp(`\\b${code}\\b`));
    const ingest = text.slice(text.indexOf('### ingest'), text.indexOf('### cost'));
    for (const needle of ['otel:', 'rows_upserted', 'duplicates']) assert.ok(ingest.includes(needle), `ingest section names ${needle}`);
  });

  it('privacy.md names the OTel canary pieces, the fail-closed rule, why --full exists and the residuals', () => {
    const text = section(read('docs/privacy.md'), '## OTel and the preserve copy');
    for (const needle of ['test/canary/preserve-scrub.test.mjs', 'test/canary/leaky-otel-normalizer.mjs', 'test/canary/plants/otel.mjs',
      'test/canary/scenarios/otel-ingest.mjs', '--full']) {
      assert.ok(text.includes(needle), `privacy.md names ${needle}`);
    }
    assert.match(text, /fail(s)? closed/i);
    assert.match(text, /residual/i);
  });

  it('operations.md has a Preserve copy section: dry run first, back up first, removal is irreversible, leftover temp files', () => {
    const text = section(read('docs/operations.md'), '## Preserve copy');
    for (const needle of ['preserve-scrub', '--apply', '.scrub-', 'back up', 'read-only']) assert.ok(text.includes(needle), `operations.md names ${needle}`);
    assert.match(text, /irreversible/i);
  });

  it('README.md lists preserve-scrub among the commands and mentions the OTel source', () => {
    const text = read('README.md');
    const commands = section(text, '## Commands');
    assert.ok(commands.includes('preserve-scrub'));
    assert.match(text, /OTel/);
  });
});
