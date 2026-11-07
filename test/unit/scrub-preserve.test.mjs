// Byte-preserving line scrub and the atomic directory rewrite behind preserve-scrub (plan 01-03, DATA-06,
// D-05, T-01-24, T-01-25). Module API under test:
//   ruleSet(full) -> { name, keys, prefixes }
//   scrubLine(bytes, rules|'default'|'full') -> { action: 'keep'|'rewrite'|'drop', bytes, removed: {rule: n}, reason }
//   scrubPreserveDir({ dir, apply, full, beforeRename, maxLineBytes }) -> { files, skipped, totals, applied, rules }
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { makeHome, sha256File } from '../fixtures/build.mjs';

let S;
const ready = async () => {
  S = await import('../../src/redact/scrub-preserve.mjs');
};

const b = (text) => Buffer.from(text, 'utf8');
const line = (o) => JSON.stringify(o);
const dirty = { ts: '2026-10-27T12:00:00.000Z', event: 'tool_result', attrs: { 'user.email': 'a@b.invalid', tool_parameters: 'TP', model: 'm', tool_input: 'TI', error: 'ER' }, resource: { 'service.version': '2.1.309' } };

function dirWith(files) {
  const ctx = makeHome();
  const dir = join(ctx.home, 'preserve');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return { ctx, dir };
}
const stat = (f) => { const st = lstatSync(f); return { sha: sha256File(f), ino: st.ino, mtime: st.mtimeMs }; };

describe('scrubLine', () => {
  it('keeps a line with no sensitive key as the same bytes, whatever its spacing', async () => {
    await ready();
    const raw = b('{ "ts" : "2026-10-27T12:00:00.000Z",\t"event":"x", "attrs": {"model":"m"} }');
    const res = S.scrubLine(raw, 'default');
    assert.equal(res.action, 'keep');
    assert.ok(res.bytes.equals(raw));
    assert.deepEqual(res.removed, {});
  });

  it('removes tool_parameters, tool_input and error from attrs and re-serializes with the other keys in their original order', async () => {
    await ready();
    const res = S.scrubLine(b(line(dirty)), 'default');
    assert.equal(res.action, 'rewrite');
    assert.equal(res.bytes.toString('utf8'), line({ ts: dirty.ts, event: 'tool_result', attrs: { 'user.email': 'a@b.invalid', model: 'm' }, resource: dirty.resource }));
    assert.deepEqual(res.removed, { tool_parameters: 1, tool_input: 1, error: 1 });
  });

  it('also removes the three keys at the top level and in resource', async () => {
    await ready();
    const res = S.scrubLine(b(line({ ts: 't', event: 'e', error: 'x', attrs: {}, resource: { tool_input: 'y', 'service.version': '1.0' } })), 'default');
    assert.equal(res.action, 'rewrite');
    assert.deepEqual(res.removed, { error: 1, tool_input: 1 });
    assert.equal(res.bytes.toString('utf8'), line({ ts: 't', event: 'e', attrs: {}, resource: { 'service.version': '1.0' } }));
  });

  it('the default rule set leaves prompt, response, branch names, identity keys and terminal.type alone (D-05)', async () => {
    await ready();
    const o = { ts: 't', event: 'e', attrs: { prompt: 'p', prompt_text: 'p', response: 'r', 'vcs.ref.head.name': 'b', 'user.id': 'u', 'organization.id': 'o', 'terminal.type': 'x' } };
    const raw = b(line(o));
    const res = S.scrubLine(raw, 'default');
    assert.equal(res.action, 'keep');
    assert.ok(res.bytes.equals(raw));
  });

  it('the full rule set removes prompt, prompt_text, response, vcs.ref.head.name, identity keys and terminal.type, counting prefix matches as user.* and organization.*', async () => {
    await ready();
    const o = { ts: 't', event: 'e', attrs: { prompt: 'p', prompt_text: 'p', response: 'r', 'vcs.ref.head.name': 'b', 'user.id': 'u', 'user.email': 'e', 'organization.id': 'o', 'terminal.type': 'x', tool_name: 'Bash' } };
    const res = S.scrubLine(b(line(o)), 'full');
    assert.equal(res.action, 'rewrite');
    assert.equal(res.bytes.toString('utf8'), line({ ts: 't', event: 'e', attrs: { tool_name: 'Bash' } }));
    assert.deepEqual(res.removed, { prompt: 1, prompt_text: 1, response: 1, 'vcs.ref.head.name': 1, 'user.*': 2, 'organization.*': 1, 'terminal.type': 1 });
  });

  it('keeps a blank line, and keeps an unparseable line that carries no quoted key of the rule set', async () => {
    await ready();
    for (const t of ['', '   ', 'not json at all', '{"ts": "2026-10-27", "attrs": {"model": "m"']) {
      const res = S.scrubLine(b(t), 'default');
      assert.equal(res.action, 'keep', t);
      assert.ok(res.bytes.equals(b(t)));
    }
    assert.equal(S.scrubLine(b('not json at all'), 'default').reason, 'unparseable_kept');
  });

  it('fails closed: an unparseable line holding a quoted key of the active rule set is dropped', async () => {
    await ready();
    for (const t of ['{"ts":"x","attrs":{"tool_parameters":"cut', '{"error":"cut', '{"attrs":{"tool_input": "cut']) {
      const res = S.scrubLine(b(t), 'default');
      assert.equal(res.action, 'drop', t);
      assert.equal(res.reason, 'unparseable_dropped');
    }
    assert.equal(S.scrubLine(b('{"attrs":{"user.email":"cut'), 'default').action, 'keep', 'identity keys are not in the default set');
    assert.equal(S.scrubLine(b('{"attrs":{"user.email":"cut'), 'full').action, 'drop');
    assert.equal(S.scrubLine(b('{"attrs":{"organization.id":"cut'), 'full').action, 'drop');
    assert.equal(S.scrubLine(b('{"attrs":{"prompt":"cut'), 'default').action, 'keep');
    assert.equal(S.scrubLine(b('{"attrs":{"prompt":"cut'), 'full').action, 'drop');
  });

  it('a non-object JSON value is kept unless it holds a quoted key', async () => {
    await ready();
    assert.equal(S.scrubLine(b('[1,2]'), 'default').action, 'keep');
    assert.equal(S.scrubLine(b('42'), 'default').action, 'keep');
    assert.equal(S.scrubLine(b('["error"]'), 'default').action, 'drop');
  });

  it('an invalid UTF-8 line that does not parse is kept byte for byte', async () => {
    await ready();
    const raw = Buffer.concat([b('not json \xff\xfe'), Buffer.from([0xff, 0xfe, 0x80])]);
    const res = S.scrubLine(raw, 'default');
    assert.equal(res.action, 'keep');
    assert.ok(res.bytes.equals(raw));
  });

  it('a line with a leading BOM parses; the BOM is dropped only when the line is rewritten', async () => {
    await ready();
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const clean = Buffer.concat([bom, b(line({ ts: 't', event: 'e', attrs: { model: 'm' } }))]);
    const keep = S.scrubLine(clean, 'default');
    assert.equal(keep.action, 'keep');
    assert.ok(keep.bytes.equals(clean));
    const rewritten = S.scrubLine(Buffer.concat([bom, b(line({ ts: 't', event: 'e', attrs: { error: 'x' } }))]), 'default');
    assert.equal(rewritten.action, 'rewrite');
    assert.ok(!rewritten.bytes.subarray(0, 3).equals(bom));
  });

  it('exports the line cap as 8 MiB', async () => {
    await ready();
    assert.equal(S.MAX_SCRUB_LINE_BYTES, 8388608);
  });
});

describe('scrubPreserveDir: dry run and apply', () => {
  const files = () => ({
    'events-2026-10-27.jsonl': `${line(dirty)}\n${line({ ts: 't', event: 'e', attrs: { model: 'm' } })}\n`,
    'metrics-2026-10-27.jsonl': `${line({ ts: 't', metric: 'm', value: 1, attrs: { 'user.id': 'u' } })}\n`,
  });

  it('a dry run writes nothing and reports the counts', async () => {
    await ready();
    const { ctx, dir } = dirWith(files());
    try {
      const before = Object.fromEntries(readdirSync(dir).map((n) => [n, stat(join(dir, n))]));
      const res = await S.scrubPreserveDir({ dir, apply: false, full: false });
      assert.equal(res.applied, false);
      for (const n of readdirSync(dir)) assert.deepEqual(stat(join(dir, n)), before[n]);
      assert.equal(res.totals.files, 2);
      assert.equal(res.totals.changedFiles, 1);
      assert.equal(res.totals.unchangedFiles, 1);
      assert.deepEqual(res.totals.removed, { tool_parameters: 1, tool_input: 1, error: 1 });
      assert.equal(res.files.find((f) => f.name === 'events-2026-10-27.jsonl').rewritten, 1);
    } finally {
      ctx.cleanup();
    }
  });

  it('apply rewrites only the dirty file, atomically, mode 0600, leaving the clean file untouched (bytes, inode, mtime)', async () => {
    await ready();
    const { ctx, dir } = dirWith(files());
    try {
      chmodSync(join(dir, 'events-2026-10-27.jsonl'), 0o644);
      const cleanBefore = stat(join(dir, 'metrics-2026-10-27.jsonl'));
      const res = await S.scrubPreserveDir({ dir, apply: true, full: false });
      assert.equal(res.applied, true);
      assert.deepEqual(stat(join(dir, 'metrics-2026-10-27.jsonl')), cleanBefore);
      const text = readFileSync(join(dir, 'events-2026-10-27.jsonl'), 'utf8');
      assert.ok(!text.includes('TP') && !text.includes('"tool_input"') && !text.includes('"error"'));
      assert.equal(text.split('\n').length, 3, 'two lines and a final newline');
      assert.equal(lstatSync(join(dir, 'events-2026-10-27.jsonl')).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.scrub-')), []);
    } finally {
      ctx.cleanup();
    }
  });

  it('preserves CRLF terminators, a missing final newline and blank lines for the lines it keeps', async () => {
    await ready();
    const keepLine = line({ ts: 't', event: 'e', attrs: { model: 'm' } });
    const { ctx, dir } = dirWith({ 'events-2026-10-27.jsonl': `${keepLine}\r\n\r\n${line(dirty)}\r\n${keepLine}` });
    try {
      await S.scrubPreserveDir({ dir, apply: true, full: false });
      const out = readFileSync(join(dir, 'events-2026-10-27.jsonl'), 'utf8');
      const rewritten = line({ ts: dirty.ts, event: 'tool_result', attrs: { 'user.email': 'a@b.invalid', model: 'm' }, resource: dirty.resource });
      assert.equal(out, `${keepLine}\r\n\r\n${rewritten}\r\n${keepLine}`);
    } finally {
      ctx.cleanup();
    }
  });

  it('keeps a BOM on an unchanged first line and drops the truncated sensitive line (fail closed)', async () => {
    await ready();
    const bom = '﻿';
    const keepLine = line({ ts: 't', event: 'e', attrs: { model: 'm' } });
    const cut = '{"ts":"t","attrs":{"tool_parameters":"cut';
    const { ctx, dir } = dirWith({ 'events-2026-10-25.jsonl': `${bom}${keepLine}\n${cut}\nnot json\n` });
    try {
      const res = await S.scrubPreserveDir({ dir, apply: true, full: false });
      assert.equal(readFileSync(join(dir, 'events-2026-10-25.jsonl'), 'utf8'), `${bom}${keepLine}\nnot json\n`);
      assert.equal(res.totals.dropped, 1);
      assert.equal(res.totals.unparseableKept, 1);
    } finally {
      ctx.cleanup();
    }
  });

  it('a second apply rewrites nothing and changes no byte, inode or mtime', async () => {
    await ready();
    const { ctx, dir } = dirWith(files());
    try {
      await S.scrubPreserveDir({ dir, apply: true, full: false });
      const mid = Object.fromEntries(readdirSync(dir).map((n) => [n, stat(join(dir, n))]));
      const again = await S.scrubPreserveDir({ dir, apply: true, full: false });
      assert.equal(again.totals.changedFiles, 0);
      for (const n of readdirSync(dir)) assert.deepEqual(stat(join(dir, n)), mid[n]);
    } finally {
      ctx.cleanup();
    }
  });

  it('--full removes the identity keys too, including from the otherwise clean metrics file', async () => {
    await ready();
    const { ctx, dir } = dirWith(files());
    try {
      const res = await S.scrubPreserveDir({ dir, apply: true, full: true });
      assert.equal(res.rules, 'full');
      assert.ok(!readFileSync(join(dir, 'metrics-2026-10-27.jsonl'), 'utf8').includes('user.id'));
      assert.ok(!readFileSync(join(dir, 'events-2026-10-27.jsonl'), 'utf8').includes('user.email'));
      assert.equal(res.totals.changedFiles, 2);
    } finally {
      ctx.cleanup();
    }
  });

  it('drops a line above maxLineBytes (oversized_dropped) without holding it, and keeps the others', async () => {
    await ready();
    const small = line({ ts: 't', event: 'e', attrs: { model: 'm' } });
    const big = line({ ts: 't', event: 'e', attrs: { model: 'm', pad: 'x'.repeat(5000) } });
    const { ctx, dir } = dirWith({ 'events-2026-10-27.jsonl': `${small}\n${big}\n${small}\n${big}` });
    try {
      const res = await S.scrubPreserveDir({ dir, apply: true, full: false, maxLineBytes: 1000 });
      assert.equal(readFileSync(join(dir, 'events-2026-10-27.jsonl'), 'utf8'), `${small}\n${small}\n`);
      assert.equal(res.totals.oversizedDropped, 2);
      assert.equal(res.totals.dropped, 2);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('scrubPreserveDir: safety', () => {
  it('skips decoys by reason (name, symlink, not_regular) and never touches them', async () => {
    await ready();
    const { ctx, dir } = dirWith({ 'events-2026-10-27.jsonl': `${line(dirty)}\n`, 'notes.txt': 'tool_parameters\n' });
    try {
      mkdirSync(join(dir, 'reports'));
      writeFileSync(join(ctx.home, 'outside.jsonl'), `${line(dirty)}\n`);
      symlinkSync(join(ctx.home, 'outside.jsonl'), join(dir, 'events-2026-10-26.jsonl'));
      mkdirSync(join(dir, 'metrics-2026-10-26.jsonl'));
      const outside = stat(join(ctx.home, 'outside.jsonl'));
      const res = await S.scrubPreserveDir({ dir, apply: true, full: true });
      assert.deepEqual(res.skipped, { name: 2, symlink: 1, not_regular: 1 });
      assert.deepEqual(stat(join(ctx.home, 'outside.jsonl')), outside);
      assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'tool_parameters\n');
    } finally {
      ctx.cleanup();
    }
  });

  it('refuses a symlinked directory and a non-directory with a typed error, writing nothing', async () => {
    await ready();
    const { ctx, dir } = dirWith({ 'events-2026-10-27.jsonl': `${line(dirty)}\n` });
    try {
      const link = join(ctx.home, 'link');
      symlinkSync(dir, link);
      const before = stat(join(dir, 'events-2026-10-27.jsonl'));
      await assert.rejects(async () => S.scrubPreserveDir({ dir: link, apply: true, full: false }), (e) => e.name === 'ScrubDirError');
      await assert.rejects(async () => S.scrubPreserveDir({ dir: join(dir, 'events-2026-10-27.jsonl'), apply: true, full: false }), (e) => e.name === 'ScrubDirError');
      await assert.rejects(async () => S.scrubPreserveDir({ dir: join(ctx.home, 'missing'), apply: true, full: false }), (e) => e.name === 'ScrubDirError');
      assert.deepEqual(stat(join(dir, 'events-2026-10-27.jsonl')), before);
    } finally {
      ctx.cleanup();
    }
  });

  it('a failure before the rename leaves the original byte-identical and no temp file, and rethrows', async () => {
    await ready();
    const { ctx, dir } = dirWith({ 'events-2026-10-27.jsonl': `${line(dirty)}\n` });
    try {
      const before = stat(join(dir, 'events-2026-10-27.jsonl'));
      let seen = null;
      await assert.rejects(async () => S.scrubPreserveDir({
        dir, apply: true, full: false,
        beforeRename: (info) => {
          const temps = readdirSync(dir).filter((n) => n.startsWith('.scrub-'));
          seen = { n: temps.length, mode: temps.length ? lstatSync(join(dir, temps[0])).mode & 0o777 : null };
          throw new Error('boom-before-rename');
        },
      }), /boom-before-rename/);
      assert.deepEqual(seen, { n: 1, mode: 0o600 });
      assert.deepEqual(stat(join(dir, 'events-2026-10-27.jsonl')), before);
      assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.scrub-')), []);
    } finally {
      ctx.cleanup();
    }
  });

  it('two scrubbers started together both finish and leave the one correct result with no temp file', async () => {
    await ready();
    const { ctx, dir } = dirWith({ 'events-2026-10-27.jsonl': `${line(dirty)}\n${line(dirty)}\n`, 'events-2026-10-26.jsonl': `${line(dirty)}\n` });
    try {
      const modUrl = new URL('../../src/redact/scrub-preserve.mjs', import.meta.url).href;
      const code = `import(${JSON.stringify(modUrl)}).then(async (m) => { await m.scrubPreserveDir({ dir: ${JSON.stringify(dir)}, apply: true, full: false }); });`;
      const run = () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
        child.on('error', reject);
        child.on('close', resolve);
      });
      const codes = await Promise.all([run(), run()]);
      assert.deepEqual(codes, [0, 0]);
      const expected = line({ ts: dirty.ts, event: 'tool_result', attrs: { 'user.email': 'a@b.invalid', model: 'm' }, resource: dirty.resource });
      assert.equal(readFileSync(join(dir, 'events-2026-10-27.jsonl'), 'utf8'), `${expected}\n${expected}\n`);
      assert.equal(readFileSync(join(dir, 'events-2026-10-26.jsonl'), 'utf8'), `${expected}\n`);
      assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.scrub-')), []);
      assert.ok(existsSync(dir));
    } finally {
      ctx.cleanup();
    }
  });

  it('the module takes no directory but the one passed: the default live receiver location is never an implicit target', async () => {
    await ready();
    const src = readFileSync(new URL('../../src/redact/scrub-preserve.mjs', import.meta.url), 'utf8');
    assert.ok(!/hook-telemetry/.test(src.replace(/\/\/.*$/gm, '')), 'no hard-coded receiver path in code');
  });
});
