// DATA-01: Node floor and node:sqlite check. checkRuntime is pure; the subprocess cases run the
// real entry point under a node that lacks the built-in sqlite module.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { makeHome, runCli, stateDirOf } from '../fixtures/build.mjs';

const load = () => import(new URL('../../src/preflight.mjs', import.meta.url).href);

describe('checkRuntime (pure)', () => {
  it('passes at the floor and above, with sqlite present', async () => {
    const { checkRuntime } = await load();
    for (const node of ['24.15.0', '24.22.1', '24.100.0', '25.0.0', '26.1.0']) {
      assert.deepEqual(checkRuntime({ node, hasSqlite: true }), { ok: true }, node);
    }
  });

  it('fails below the floor with exit 2 and a one-line message', async () => {
    const { checkRuntime } = await load();
    for (const node of ['24.14.9', '24.9.0', '23.99.0', '22.22.3']) {
      const r = checkRuntime({ node, hasSqlite: true });
      assert.equal(r.ok, false, node);
      assert.equal(r.exit, 2, node);
      assert.equal(typeof r.msg, 'string', node);
      assert.ok(!/[\r\n]/.test(r.msg), `${node}: message must be a single line`);
    }
  });

  it('compares versions numerically per segment, not as strings', async () => {
    const { checkRuntime } = await load();
    assert.equal(checkRuntime({ node: '24.9.0', hasSqlite: true }).ok, false);
    assert.equal(checkRuntime({ node: '24.14.9', hasSqlite: true }).ok, false);
    assert.equal(checkRuntime({ node: '24.100.0', hasSqlite: true }).ok, true);
    assert.equal(checkRuntime({ node: '100.0.0', hasSqlite: true }).ok, true);
  });

  it('never throws on an empty, undefined or malformed version; always ok false exit 2', async () => {
    const { checkRuntime } = await load();
    const bad = ['', undefined, null, '24', '24.15', 'garbage', 24, {}, [], '24.x.0'];
    for (const node of bad) {
      let r;
      assert.doesNotThrow(() => { r = checkRuntime({ node, hasSqlite: true }); }, String(node));
      assert.equal(r.ok, false, String(node));
      assert.equal(r.exit, 2, String(node));
      assert.ok(!/[\r\n]/.test(r.msg), 'single line');
    }
    assert.doesNotThrow(() => checkRuntime());
    assert.doesNotThrow(() => checkRuntime({}));
    assert.equal(checkRuntime().ok, false);
  });

  it('fails when hasSqlite is false or undefined, and the message names node:sqlite', async () => {
    const { checkRuntime } = await load();
    for (const hasSqlite of [false, undefined]) {
      const r = checkRuntime({ node: '24.22.1', hasSqlite });
      assert.equal(r.ok, false);
      assert.equal(r.exit, 2);
      assert.match(r.msg, /node:sqlite/);
      assert.ok(!/[\r\n]/.test(r.msg));
    }
  });

  it('names the found version and the fix for an old node', async () => {
    const { checkRuntime } = await load();
    const r = checkRuntime({ node: '24.13.0', hasSqlite: true });
    assert.match(r.msg, /24\.13\.0/);
    assert.match(r.msg, /24\.15\.0/);
    assert.match(r.msg, /nvm install/);
  });

  it('exports the floor as numbers', async () => {
    const { NODE_FLOOR } = await load();
    assert.deepEqual({ ...NODE_FLOOR }, { major: 24, minor: 15 });
  });

  it('does not import the built-in sqlite module itself', async () => {
    const text = readFileSync(new URL('../../src/preflight.mjs', import.meta.url), 'utf8');
    assert.ok(!/from\s+['"]node:sqlite['"]/.test(text));
    assert.ok(!/import\(\s*['"]node:sqlite['"]/.test(text));
  });

  it('runPreflight reports ok on this runtime', async () => {
    const { runPreflight } = await load();
    assert.deepEqual(runPreflight(), { ok: true });
  });
});

describe('bin entry under a node without node:sqlite', () => {
  it('exits 2 with one stderr line naming the sqlite module, empty stdout, nothing created', () => {
    const ctx = makeHome();
    try {
      const r = runCli(['cost'], { home: ctx.home, nodeArgs: ['--no-experimental-sqlite'] });
      assert.equal(r.status, 2);
      assert.equal(r.stdout, '');
      const lines = r.stderr.split('\n').filter((l) => l.length > 0);
      assert.equal(lines.length, 1, 'exactly one stderr line');
      assert.match(lines[0], /node:sqlite/);
      assert.equal(existsSync(stateDirOf(ctx.home)), false, 'no .rigorscope directory created');
    } finally {
      ctx.cleanup();
    }
  });

  it('is executable and starts with a node shebang', () => {
    const text = readFileSync(new URL('../../bin/rigorscope.mjs', import.meta.url), 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env node'));
    const mode = statSync(new URL('../../bin/rigorscope.mjs', import.meta.url)).mode;
    assert.ok((mode & 0o111) !== 0, 'executable bit set');
  });
});
