// parseQuickId under fixed zones (plan 02-02 D-11; review 02-02 WR-02). A quick id YYMMDD-xxx is read as the local date
// 20YY-MM-DD in the zone of the ingest process, and the stored offset must place start_ms (unixepoch(date) minus the
// offset) at the first instant of that local day. Where DST starts at midnight, local midnight does not exist and the
// day starts at 01:00; the offset is then the one in force just before the transition, never the post-transition one.
//
// parseQuickId reads the process zone, so every case runs in a child process with TZ set; nothing else is read. The
// expected offsets are taken from each zone's rule, not from the code: America/Santiago starts DST at 24:00 on
// 2025-09-06 (-04 before), America/Havana at 00:00 on 2026-03-08 (-05 before), Asia/Beirut at 00:00 on 2026-03-29
// (+02 before); America/New_York has no transition on 2026-10-30 (-04, EDT), Asia/Tokyo none at all (+09).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ADAPTER = new URL('../../src/adapters/gsd-core/index.mjs', import.meta.url).href;
const REPO = fileURLToPath(new URL('../../', import.meta.url));

function parseIn(tz, name) {
  const script = `import { parseQuickId } from ${JSON.stringify(ADAPTER)};
process.stdout.write(JSON.stringify(parseQuickId(${JSON.stringify(name)})));`;
  const env = { TZ: tz };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const localDay = (ms, tz) => new Intl.DateTimeFormat('en-CA', {
  timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(ms);

const CASES = [
  // [zone, quick id, local date, offset of the first instant of that day in minutes, midnight-DST day]
  ['America/Santiago', '250907-aaa', '2025-09-07', -240, true],
  ['America/Havana', '260308-aaa', '2026-03-08', -300, true],
  ['Asia/Beirut', '260329-aaa', '2026-03-29', 120, true],
  ['America/New_York', '261030-a1b', '2026-10-30', -240, false],
  ['Asia/Tokyo', '261030-aaa', '2026-10-30', 540, false],
];

describe('parseQuickId: the local date and the offset of its first instant (review WR-02)', () => {
  for (const [tz, name, date, offsetMin, dst] of CASES) {
    it(`${tz} ${name}${dst ? ' (DST starts at midnight)' : ''}`, () => {
      const got = parseIn(tz, name);
      assert.deepEqual(got, { id: name.slice(0, 10), date, offsetMin });
      const startMs = Date.parse(`${date}T00:00:00Z`) - got.offsetMin * 60000;
      assert.equal(localDay(startMs, tz), date, 'start_ms falls on the quick id date in its zone');
      assert.notEqual(localDay(startMs - 1, tz), date, 'start_ms is the first instant of that day');
    });
  }

  it('an impossible date keeps no date and no offset in any zone', () => {
    assert.deepEqual(parseIn('America/Santiago', '250231-aaa'), { id: '250231-aaa', date: null, offsetMin: null });
  });
});
