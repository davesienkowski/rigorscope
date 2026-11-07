// Plan 03-04 (LEDG-07, D-18; threat T-03-45): the static overhead estimate per unit kind and the ledger calls per forward unit.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OVERHEAD_CAP_TOKENS, OVERHEAD_LABEL, ledgerCalls, loadOverhead, overCap, overheadFromSizes, readSizes,
} from '../../src/report/overhead.mjs';
import { overheadLine } from '../../src/report/render-text.mjs';

const fwdUnit = (lines) => ({ population: 'forward', ledger: { lines } });

describe('overhead estimate', () => {
  it('the shipped capability files are at or below the cap for both kinds and the finding is none', () => {
    const o = loadOverhead([]);
    assert.equal(o.cap_tokens, 300);
    for (const k of ['plan', 'quick']) {
      assert.ok(o.kinds[k] !== null && o.kinds[k].tokens > 0 && o.kinds[k].tokens <= OVERHEAD_CAP_TOKENS, k);
    }
    assert.deepEqual(o.finding, []);
  });
  it('estimate is labeled: the line carries estimate (chars/4) before the figures and says they are file sizes, not measurements', () => {
    const text = overheadLine(loadOverhead([fwdUnit(2), fwdUnit(3)]));
    assert.ok(text.startsWith(`overhead: ${OVERHEAD_LABEL} tokens per unit kind: plan=`), text);
    assert.match(text, /finding=none/);
    assert.match(text, /file sizes, not rendered prompt cost/);
    assert.match(text, /per-session skill description cost is separate/);
    assert.ok(!text.includes(process.cwd()) && !text.includes('capabilities/'), 'no path');
  });
  it('fed a 1204-character text the module reports over the cap and the finding names the kind', () => {
    assert.equal(overCap(1204), true);
    assert.equal(overCap(1200), false);
    const o = overheadFromSizes({ start: 600, close: 604, fragment: 100 });
    assert.deepEqual(o.finding, ['plan']);
    assert.equal(o.kinds.plan.tokens, 301);
    assert.match(overheadLine({ ...o, cap_tokens: 300, label: OVERHEAD_LABEL, ledger_calls: ledgerCalls([]) }), /finding=plan/);
  });
  it('a missing capability directory or file is ? and an unknown finding, never 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-overhead-'));
    try {
      const o = loadOverhead([], { dir: join(dir, 'absent') });
      assert.deepEqual([o.kinds.plan, o.kinds.quick, o.finding], [null, null, null]);
      assert.match(overheadLine(o), /plan=\? quick=\?.*finding=\?/);
      mkdirSync(join(dir, 'skills', 'forward-ledger-start'), { recursive: true });
      writeFileSync(join(dir, 'skills', 'forward-ledger-start', 'SKILL.md'), 'x'.repeat(40));
      assert.deepEqual(readSizes(dir), { start: 40, close: null, fragment: null });
      assert.equal(overheadFromSizes(readSizes(dir)).kinds.plan, null, 'one missing file makes the kind unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('calls per forward unit: median (lower middle) and max over the ledger line counts, ? with no forward unit', () => {
    assert.deepEqual(ledgerCalls([fwdUnit(2), fwdUnit(3), { population: 'reconstructed', ledger: null }]), { n: 2, median: 2, max: 3 });
    assert.deepEqual(ledgerCalls([fwdUnit(1), fwdUnit(2), fwdUnit(9)]), { n: 3, median: 2, max: 9 });
    assert.deepEqual(ledgerCalls([]), { n: 0, median: null, max: null });
    assert.match(overheadLine(loadOverhead([])), /median=\? max=\? \(no forward unit\)/);
  });
});
