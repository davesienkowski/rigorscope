// Plan 02-05 (ADPT-01): the file-name-to-role table of src/adapters/gsd-core/artifacts.mjs, the phase-level rule, the
// SUMMARY `completed:` date reader and the local-midnight offset. Pure; the module is imported inside each case, so
// this file loads before the code exists.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import('../../src/adapters/gsd-core/artifacts.mjs');
const Q = { kind: 'quick', nativeId: '261021-k1m' };
const P = { kind: 'plan', nativeId: '02-01' };

describe('artifactRole: quick units', () => {
  it('maps every quick role name and nothing else', async () => {
    const { artifactRole } = await mod();
    const cases = [
      ['261021-k1m-PLAN.md', 'plan'], ['261021-k1m-SUMMARY.md', 'summary'], ['261021-k1m-CONTEXT.md', 'context'],
      ['261021-k1m-VERIFICATION.md', 'verification'], ['261021-k1m-REVIEW.md', 'review'],
      ['261021-k1m-REVIEW-2.md', 'review'], ['261021-k1m-REVIEW-R3.md', 'review'], ['261021-k1m-WINDOWS.md', 'windows'],
      ['RIGOR-TIER.md', 'rigor-tier'], ['RIGOR-TIERS.txt', 'rigor-tier'], ['261021-k1m-PROBES-SKIPPED.md', 'probes-skipped'],
      ['261021-k1m-EDGE-REQS.json', 'probe'], ['261021-k1m-EDGE-RESOLUTIONS.json', 'probe'], ['261021-k1m-EDGES.json', 'probe'],
      ['261021-k1m-PROHIBITIONS.json', 'probe'], ['261021-k1m-UI-CONSIDERATIONS.json', 'probe'],
      ['261021-k1m-PROBE-GATE.json', 'probe'], ['261021-k1m-REFUTE.md', 'refute-pass'], ['261021-k1m-REFUTE-2.md', 'refute-pass'],
      ['261021-k1m-REFUTE-GATE.json', 'refute-pass'], ['261021-k1m-CLAIMS.json', 'refute-pass'],
      ['261021-k1m-RESEARCH.md', null], ['261021-k1m-PATTERNS.md', null], ['261021-k1m-VALIDATION.md', null],
      ['261021-k1m-RED.txt', null], ['notes.txt', null], ['261021-k1m-LOG.md', null], ['261021-k1m-REVIEW-x.md', null],
      ['261021-k1m-REVIEW-.md', null], ['261021-k1m-REFUTE-R2.md', null],
      ['261099-zzz-PLAN.md', null], ['xx-PLAN.md', null], ['PLAN.md', null], ['261021-k1m-PLAN.md.bak', null],
    ];
    for (const [name, role] of cases) assert.equal(artifactRole(name, Q), role, name);
  });

  it('the phase-level names are not roles of a quick unit', async () => {
    const { artifactRole } = await mod();
    for (const name of ['02-CONTEXT.md', '26-CONTEXT.md', '261021-CONTEXT.md']) assert.equal(artifactRole(name, Q), null, name);
  });
});

describe('artifactRole: phase plans', () => {
  it('maps the own-id names, never rigor-tier or probes-skipped', async () => {
    const { artifactRole } = await mod();
    const cases = [
      ['02-01-PLAN.md', 'plan'], ['02-01-SUMMARY.md', 'summary'], ['02-01-REVIEW.md', 'review'], ['02-01-REVIEW-R2.md', 'review'],
      ['02-01-CONTEXT.md', 'context'], ['02-01-EDGES.json', 'probe'], ['02-01-CLAIMS.json', 'refute-pass'],
      ['RIGOR-TIER.md', null], ['02-01-PROBES-SKIPPED.md', null], ['02-01-RESEARCH.md', null],
    ];
    for (const [name, role] of cases) assert.equal(artifactRole(name, P), role, name);
  });

  it('a phase-level CONTEXT, VERIFICATION, review or WINDOWS file belongs to every plan of the dir', async () => {
    const { artifactRole } = await mod();
    const cases = [
      ['02-CONTEXT.md', 'context'], ['02-VERIFICATION.md', 'verification'], ['02-REVIEW.md', 'review'],
      ['02-REVIEW-2.md', 'review'], ['02-REVIEW-R4.md', 'review'], ['02-WINDOWS.md', 'windows'],
      ['02-RESEARCH.md', null], ['02-PATTERNS.md', null], ['02-VALIDATION.md', null], ['02-PLAN.md', null], ['02-SUMMARY.md', null],
      ['02-EDGES.json', null],
    ];
    for (const [name, role] of cases) assert.equal(artifactRole(name, P), role, name);
    assert.equal(artifactRole('02.1-CONTEXT.md', { kind: 'plan', nativeId: '02.1-01' }), 'context');
    assert.equal(artifactRole('02-CONTEXT.md', { kind: 'plan', nativeId: '02.1-01' }), null);
  });

  it('another plan\'s files are never this plan\'s', async () => {
    const { artifactRole } = await mod();
    for (const name of ['02-02-PLAN.md', '02-02-REVIEW.md', '02-02-SUMMARY.md', '02-10-CONTEXT.md', '03-01-PLAN.md']) {
      assert.equal(artifactRole(name, P), null, name);
    }
  });

  it('PLAN_FILE_RE and phasePartOf read the plan id', async () => {
    const { PLAN_FILE_RE, phasePartOf } = await mod();
    assert.equal(PLAN_FILE_RE.exec('02-01-PLAN.md')?.[1], '02-01');
    assert.equal(PLAN_FILE_RE.exec('02.1-01-PLAN.md')?.[1], '02.1-01');
    assert.equal(PLAN_FILE_RE.exec('02-PLAN.md'), null);
    assert.equal(PLAN_FILE_RE.exec('x02-01-PLAN.md'), null);
    assert.equal(phasePartOf('03-01'), '03');
    assert.equal(phasePartOf('02.1-01'), '02.1');
  });

  it('ARTIFACT_ROLES lists the ten roles and ARTIFACT_RULES covers all of them', async () => {
    const { ARTIFACT_ROLES, ARTIFACT_RULES } = await mod();
    assert.deepEqual(ARTIFACT_ROLES, ['plan', 'summary', 'context', 'verification', 'review', 'windows', 'rigor-tier',
      'probes-skipped', 'probe', 'refute-pass']);
    const covered = new Set(ARTIFACT_RULES.map((r) => r.role));
    for (const r of ARTIFACT_ROLES) assert.ok(covered.has(r), r);
  });
});

describe('completedDate and localMidnightOffsetMin', () => {
  it('reads a top-level completed date, quoted or not, and nothing else', async () => {
    const { completedDate } = await mod();
    assert.equal(completedDate(['status: complete', 'completed: 2026-10-26']), '2026-10-26');
    assert.equal(completedDate(['completed: "2026-10-26"']), '2026-10-26');
    assert.equal(completedDate(["completed: '2026-10-26'"]), '2026-10-26');
    assert.equal(completedDate(['  completed: 2026-10-26']), null);
    assert.equal(completedDate(['metrics:', '  completed: 2026-10-26']), null);
    assert.equal(completedDate(['completed: 2026-02-31']), null);
    assert.equal(completedDate(['completed: 2026-1-5']), null);
    assert.equal(completedDate(['completed: 2026-10-26T10:00:00Z']), null);
    assert.equal(completedDate(null), null);
    assert.equal(completedDate([]), null);
  });

  it('the offset of a local midnight puts that midnight at the local day start (process zone)', async () => {
    const { localMidnightOffsetMin } = await mod();
    for (const d of ['2026-01-15', '2026-07-15', '2026-10-26']) {
      const off = localMidnightOffsetMin(d);
      assert.ok(Number.isInteger(off) && off >= -900 && off <= 900, d);
      const [y, m, day] = d.split('-').map(Number);
      const at = new Date(Date.UTC(y, m - 1, day) - off * 60000);
      assert.deepEqual([at.getFullYear(), at.getMonth() + 1, at.getDate(), at.getHours(), at.getMinutes()], [y, m, day, 0, 0], d);
    }
    assert.equal(localMidnightOffsetMin('2026-02-31'), null);
  });
});
