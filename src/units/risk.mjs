// The risk class of a reconstructed unit (plan 02-03, D-05, D-06). Pure: no import, no I/O. The table comes from
// src/units/risk-rules.mjs (loadRiskRules); derive (plan 02-05) calls these functions over the stored touched paths.
//
// touchedPaths picks the unit's touched files: the PLAN's files_modified when it is a non-empty list, else the
// deduplicated files of the unit's commits, else none (an empty files_modified list falls back like an absent key).
// riskOf tags the touched paths outside the table's excluded prefixes (`.planning/`): a path rule tags a path when its
// pattern matches and its `not` pattern does not; `docs` is set only when at least one considered path exists and
// every considered path matches the docs-only rule; `script` is dropped when a more specific tag (the table's
// script_unless list) is present. risk_class is the tags sorted bytewise; risk_source is, per tag in that order, the
// `rule:<id>@<version>` of the first matching rule in table order, joined by commas.
//
// Home prefix (review WR-03): a path starting `~/` and one starting `$HOME/` name the same place (the collector writes
// an absolute path under HOME as `~/...` and keeps a written `$HOME/...`), so a path rule is tried on the path and on
// its twin with the other prefix, and tags the path when either spelling matches the pattern and not the `not`
// pattern. The table is not edited: it names `~/.claude/`, `$HOME/.claude/` and `$HOME/.gsd/`, and this reading also
// tags `~/.gsd/`. Only a leading prefix is read as home.
//
// Empty versus unknown (D-05, TRUST-01): considered paths that match no rule give `[]` with risk_source `none`, a
// known empty stratum, never a default tag; no touched path at all (source none: no files_modified and no commit
// files, or commit facts unavailable) gives risk_class NULL with risk_source `no-evidence`, shown as unknown.

export const RISK_TAGS = Object.freeze(['gate-or-hook', 'security', 'parser', 'global-config', 'script', 'docs']);

const compareBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

const HOME_PREFIXES = Object.freeze(['~/', '$HOME/']);

// -> the path and, when it starts with a home prefix, its twin with the other one.
function spellingsOf(p) {
  for (const pre of HOME_PREFIXES) {
    if (p.startsWith(pre)) return [p, ...HOME_PREFIXES.filter((o) => o !== pre).map((o) => `${o}${p.slice(pre.length)}`)];
  }
  return [p];
}
const ruleTags = (rule, p) => spellingsOf(p).some((s) => rule.re.test(s) && !(rule.not && rule.not.test(s)));

// -> { paths, source } with source files_modified, commits or none (paths [] for none).
export function touchedPaths({ filesModified, commits } = {}) {
  if (Array.isArray(filesModified) && filesModified.length > 0) {
    return { paths: [...filesModified], source: 'files_modified' };
  }
  const set = new Set();
  for (const c of Array.isArray(commits) ? commits : []) {
    for (const f of Array.isArray(c?.files) ? c.files : []) if (typeof f?.path === 'string') set.add(f.path);
  }
  if (set.size > 0) return { paths: [...set].sort(compareBytes), source: 'commits' };
  return { paths: [], source: 'none' };
}

// -> { risk_class, risk_source } (see the header).
export function riskOf({ paths, source } = {}, table) {
  if (source === 'none' || !Array.isArray(paths) || paths.length === 0) return { risk_class: null, risk_source: 'no-evidence' };
  const considered = paths.filter((p) => typeof p === 'string' && !table.excludePrefixes.some((pre) => p.startsWith(pre)));
  const firstRule = new Map();
  for (const rule of table.rules) {
    if (firstRule.has(rule.tag)) continue;
    if (considered.some((p) => ruleTags(rule, p))) firstRule.set(rule.tag, rule.id);
  }
  firstRule.delete('docs');
  if (considered.length > 0 && considered.every((p) => table.docsOnly.re.test(p))) firstRule.set('docs', table.docsOnly.id);
  if (table.scriptUnless.specific.some((t) => firstRule.has(t))) firstRule.delete('script');
  const tags = [...firstRule.keys()].sort(compareBytes);
  if (tags.length === 0) return { risk_class: [], risk_source: 'none' };
  return { risk_class: tags, risk_source: tags.map((t) => `rule:${firstRule.get(t)}@${table.version}`).join(',') };
}
