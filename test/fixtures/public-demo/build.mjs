// The synthetic public demo fixture: a small git repository with four quick units and a home with transcript files for
// them, built from code with a fixed clock, fixed dates and the git identity `fixture`. Nothing is copied from a real
// session. The known answers are in expected.json, derived by hand from the numbers below and the shipped price file.
//
//   units (UTC)     tier  commits                                 call (opus unless noted)
//   261001-d1a      A     plan 10-01 09:00, code 10-01 12:00      10-01 10:00  1000 / 500 / 20000 / 2000
//   261002-d2b      B     plan 10-02 09:00, code 10-02 12:00      10-02 10:00  2000 / 1000 / 10000 / 1000
//   261003-d3c      C     plan 10-03 09:00 (no code commit)       10-03 08:00  3000 / 1000 / 10000 / 2000 (sonnet)
//   261004-d4d      B     plan 10-04 09:00, code 10-04 12:00      10-04 10:00  2000 / 500 / 5000 / 400 (sonnet)
//   a call outside any repository on 10-05 20:00 (500 / 100 / 0 / 0) attaches to no unit.
// archive() moves d4d into a milestone archive and adds a live directory that reuses its id; run ingest before and after.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeAssistant, makeUsage, mangleHome, writeJsonl,
} from '../build.mjs';
import {
  archiveDir, assertOutsideWorkTree, commitAt, makeRepo, writeFileAt, writeQuickDir,
} from '../git-repo.mjs';

export const DEMO_UNITS = Object.freeze([
  { id: '261001-d1a', short: 'd1a', slug: 'login-form', tier: 'A', model: 'claude-opus-5-5', call: '2026-10-01T10:00:00.000Z', tokens: [1000, 500, 20000, 2000], plan: '2026-10-01T09:00:00Z', code: '2026-10-01T12:00:00Z' },
  { id: '261002-d2b', short: 'd2b', slug: 'report-page', tier: 'B', model: 'claude-opus-5-5', call: '2026-10-02T10:00:00.000Z', tokens: [2000, 1000, 10000, 1000], plan: '2026-10-02T09:00:00Z', code: '2026-10-02T12:00:00Z' },
  { id: '261003-d3c', short: 'd3c', slug: 'notes-only', tier: 'C', model: 'claude-sonnet-5-5', call: '2026-10-03T08:00:00.000Z', tokens: [3000, 1000, 10000, 2000], plan: '2026-10-03T09:00:00Z', code: null },
  { id: '261004-d4d', short: 'd4d', slug: 'export-job', tier: 'B', model: 'claude-sonnet-5-5', call: '2026-10-04T10:00:00.000Z', tokens: [2000, 500, 5000, 400], plan: '2026-10-04T09:00:00Z', code: '2026-10-04T12:00:00Z' },
]);
const LOOSE = Object.freeze({ call: '2026-10-05T20:00:00.000Z', tokens: [500, 100, 0, 0], model: 'claude-opus-5-5' });
const ARCHIVE_AT = '2026-10-05T08:00:00Z';
const REUSE_AT = '2026-10-05T08:30:00Z';
const SESSION = (n) => `de00000${n}-0000-4000-8000-00000000000${n}`;

const codeText = (name) => `export const ${name} = 1;\nexport const ${name}Two = 2;\nexport const ${name}Three = 3;\n`;
const unitDir = (u) => `.planning/quick/${u.id}-${u.slug}`;

function writeCall({ root, cwd, session, id, ts, model, tokens, editPath }) {
  const [input, output, read, creation] = tokens;
  const content = editPath
    ? [{ type: 'tool_use', id: `toolu_demo_${id}`, name: 'Edit', input: { file_path: editPath } }, { type: 'text', text: 'ok' }]
    : undefined;
  const line = makeAssistant({
    session, ts, id: `msg_demo_${id}`, model, cwd, ...(content ? { content } : {}),
    use: makeUsage({ input, output, read, creation, c5: creation, c1: 0 }),
  });
  writeJsonl(join(root, 'projects', mangleHome(cwd), `${session}.jsonl`), [JSON.stringify(line)]);
}

// dir: an empty directory outside any git work tree that the caller owns. -> { repo, home, root, archive }
export function buildPublicDemo({ dir }) {
  assertOutsideWorkTree(dir);
  const home = join(dir, 'home');
  const root = join(home, '.claude');
  const repo = join(home, 'repos', 'demo');
  const plain = join(home, 'work', 'plain');
  mkdirSync(plain, { recursive: true });
  makeRepo(repo, { home, files: { 'README.md': 'demo\n' } });
  DEMO_UNITS.forEach((u, i) => {
    writeQuickDir(repo, { id: u.id, slug: u.slug, plan: { tier: u.tier, body: 'Synthetic demo unit.' } });
    commitAt(repo, { home, date: u.plan, message: `docs(${u.id}): plan` });
    if (u.code) {
      writeFileAt(repo, `src/${u.short}.mjs`, codeText(u.short));
      commitAt(repo, { home, date: u.code, message: `feat(${u.id}): build` });
    }
    writeCall({
      root, cwd: repo, session: SESSION(i + 1), id: u.short, ts: u.call, model: u.model, tokens: u.tokens,
      editPath: join(repo, unitDir(u), `${u.id}-PLAN.md`),
    });
  });
  writeCall({
    root, cwd: plain, session: SESSION(5), id: 'loose', ts: LOOSE.call, model: LOOSE.model, tokens: LOOSE.tokens,
  });
  const archive = () => {
    const d4d = DEMO_UNITS[3];
    archiveDir(repo, { home, name: `${d4d.id}-${d4d.slug}`, label: 'v1.0', kind: 'quick' });
    commitAt(repo, { home, date: ARCHIVE_AT, message: 'chore: archive milestone v1.0' });
    writeQuickDir(repo, { id: d4d.id, slug: 'export-job-again', plan: { tier: 'B', body: 'A later milestone reused the id.' } });
    commitAt(repo, { home, date: REUSE_AT, message: 'chore: start milestone v2.0' });
  };
  return { repo, home, root, archive };
}

