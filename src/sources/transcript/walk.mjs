// The nested walk of ROOT/projects (D-03, T-01-12). lstat decides everything and a symlink is never
// followed. Only these paths are read:
//   projects/PROJECT/SESSION.jsonl                          kind session
//   projects/PROJECT/SESSION/subagents/**/agent-ID.jsonl    kind subagent (any depth up to the cap)
//   projects/PROJECT/SESSION/subagents/**/agent-ID.meta.json kind meta
// Everything else is skipped with a reason (journal, name, symlink, depth) or never entered (other
// session subdirectories, anything outside projects/). Each unit carries a root alias and a
// home-normalized relative path; the absolute path is used only to read the file.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compareBytes } from './roots.mjs';
import { normalizeProjectSegment } from './home.mjs';

export const MAX_WALK_DEPTH = 8;

const NAME = /^[A-Za-z0-9._-]{1,200}$/;
const SESSION_FILE = /^([A-Za-z0-9._-]{1,128})\.jsonl$/;
const AGENT_FILE = /^agent-([A-Za-z0-9._-]{1,128})\.jsonl$/;
const META_FILE = /^agent-([A-Za-z0-9._-]{1,128})\.meta\.json$/;

const sorted = (dir) => {
  try { return readdirSync(dir).sort(compareBytes); } catch { return null; }
};
const stat = (p) => {
  try { return lstatSync(p); } catch { return null; }
};

export function walkRoot(root, { homeSet, maxDepth = MAX_WALK_DEPTH } = {}) {
  const skipped = {};
  const units = [];
  const skip = (reason) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  const projectsDir = join(root.path, 'projects');
  const pst = stat(projectsDir);
  if (!pst || pst.isSymbolicLink() || !pst.isDirectory()) return { units, skipped, noProjects: true };

  const walkAgents = (dir, depth, relPrefix, ids) => {
    for (const name of sorted(dir) ?? []) {
      const p = join(dir, name);
      const st = stat(p);
      if (!st) { skip('unreadable'); continue; }
      if (st.isSymbolicLink()) { skip('symlink'); continue; }
      if (st.isDirectory()) {
        if (!NAME.test(name)) { skip('name'); continue; }
        if (depth + 1 > maxDepth) { skip('depth'); continue; }
        walkAgents(p, depth + 1, `${relPrefix}/${name}`, ids);
        continue;
      }
      if (!st.isFile()) { skip('name'); continue; }
      if (name === 'journal.jsonl') { skip('journal'); continue; }
      const a = AGENT_FILE.exec(name);
      const m = a ? null : META_FILE.exec(name);
      if (!a && !m) { skip('name'); continue; }
      units.push({
        rootAlias: root.alias,
        rel: `${relPrefix}/${name}`,
        abs: p,
        kind: a ? 'subagent' : 'meta',
        whole: Boolean(m),
        sessionId: ids.sessionId,
        agentId: (a ?? m)[1],
      });
    }
  };

  for (const proj of sorted(projectsDir) ?? []) {
    const pdir = join(projectsDir, proj);
    const st = stat(pdir);
    if (!st) { skip('unreadable'); continue; }
    if (st.isSymbolicLink()) { skip('symlink'); continue; }
    if (!st.isDirectory()) continue;
    if (!NAME.test(proj)) { skip('name'); continue; }
    const seg = normalizeProjectSegment(proj, homeSet);
    for (const name of sorted(pdir) ?? []) {
      const p = join(pdir, name);
      const fst = stat(p);
      if (!fst) { skip('unreadable'); continue; }
      if (fst.isSymbolicLink()) { skip('symlink'); continue; }
      if (fst.isFile()) {
        const s = SESSION_FILE.exec(name);
        if (!s) { skip('name'); continue; }
        units.push({ rootAlias: root.alias, rel: `${seg}/${name}`, abs: p, kind: 'session', whole: false, sessionId: s[1] });
        continue;
      }
      if (!fst.isDirectory()) { skip('name'); continue; }
      if (!NAME.test(name)) { skip('name'); continue; }
      const sub = join(p, 'subagents');
      const sst = stat(sub);
      if (!sst) continue; // a session directory without sub-agents (tool-results and the like are never entered)
      if (sst.isSymbolicLink()) { skip('symlink'); continue; }
      if (sst.isDirectory()) walkAgents(sub, 0, `${seg}/${name}/subagents`, { sessionId: name });
    }
  }
  units.sort((x, y) => compareBytes(x.rel, y.rel));
  return { units, skipped, noProjects: false };
}
