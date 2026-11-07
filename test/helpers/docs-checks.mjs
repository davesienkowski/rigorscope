// Pure checkers for the public docs set (plan 09-05). Each takes page text and file sets as arguments, so a test can run it
// on planted input in a temp directory. The self-reference forms and private words are built from fragments, so this file
// itself holds none of them as a literal.
import { dirname, posix } from 'node:path';

const PLAN_DIR = ['.plan', 'ning'].join('');
const SELF_FORMS = [
  { name: 'planning phases path', re: new RegExp(`${PLAN_DIR}/phases/`) },
  { name: 'planning notes path', re: new RegExp(`${PLAN_DIR}/notes/`) },
  { name: 'planning research path', re: new RegExp(`${PLAN_DIR}/research/`) },
  { name: 'roadmap word', re: new RegExp(['road', 'map'].join(''), 'i') },
  { name: 'phase number', re: new RegExp(`\\b${['Ph', 'ase'].join('')} \\d`) },
  { name: 'plan number', re: new RegExp(`\\b${['pl', 'an'].join('')} \\d{2}(?:\\.\\d+)?-\\d{2}`, 'i') },
];

const stripFences = (text) => text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, (m) => m.replace(/[^\n]/g, ' '));

// GitHub-style anchors of the headings of a page (duplicates get -1, -2 ...).
export function anchorsOf(text) {
  const seen = new Map();
  const out = new Set();
  for (const m of stripFences(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = m[1].replace(/`/g, '').toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

// pages: the public page paths (repo-relative, posix). exists(rel) -> boolean for any repo-relative path.
// readPage(rel) -> text of a public page. -> list of problem strings.
export function checkLinks({ page, text, pages, exists, readPage, topDirs = ['src', 'bin', 'test', 'data', 'scripts', 'capabilities'], rootFiles = ['LICENSE', 'NOTICE', 'package.json'] }) {
  const problems = [];
  const body = stripFences(text);
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [pathPart, anchor] = target.split('#');
    const rel = pathPart === '' ? page : posix.normalize(posix.join(dirname(page), pathPart));
    if (rel.startsWith('..')) { problems.push(`${page}: ${target} leaves the repository`); continue; }
    const top = rel.split('/')[0];
    if (rel.endsWith('.md') && (rel.startsWith('docs/') || rel === 'README.md')) {
      if (!pages.includes(rel)) { problems.push(`${page}: ${target} is a page outside the public set`); continue; }
      if (!exists(rel)) { problems.push(`${page}: ${target} does not exist`); continue; }
      if (anchor !== undefined && !anchorsOf(readPage(rel)).has(anchor)) problems.push(`${page}: anchor #${anchor} not found in ${rel}`);
      continue;
    }
    if (!topDirs.includes(top) && !rootFiles.includes(rel)) { problems.push(`${page}: ${target} is outside the shipped directories`); continue; }
    if (!exists(rel.replace(/\/$/, ''))) problems.push(`${page}: ${target} does not exist`);
    if (anchor !== undefined && !rel.endsWith('.md')) problems.push(`${page}: ${target} has an anchor on a non-page`);
  }
  return problems;
}

// exempt: [{ page, includes }]: a line of that page holding that text describes a path in the reader's own repository, so the
// self-reference forms are not applied to it. The allowlist lives in the test, not in the page source.
// -> list of `page:line form` for a self-reference form on a line that is not exempt.
export function checkSelfReference({ page, text, exempt = [] }) {
  const out = [];
  const marks = exempt.filter((e) => e.page === page).map((e) => e.includes);
  text.split('\n').forEach((line, i) => {
    if (marks.some((m) => line.includes(m))) return;
    for (const f of SELF_FORMS) if (f.re.test(line)) out.push(`${page}:${i + 1} ${f.name}`);
  });
  return out;
}

// Wording rules of the public pages (plan 09-05 fix round): no decision or planning ids, no build or version phrasing, no
// dates outside code, no third-person pronouns for the reader or the maintainer (they/them only). Forms are built from
// fragments so this file holds none as a literal.
const WORDING_FORMS = [
  { name: 'ADR number', re: new RegExp(`\\b${['A', 'DR'].join('')}[- ]?\\d`) },
  { name: 'decision id', re: /\bD-\d\d\b/ },
  { name: 'phase id', re: new RegExp(`\\b${['ph', 'ase'].join('')}-\\d`, 'i') },
  { name: 'owner role id', re: new RegExp(`\\b${['ow', 'ner'].join('')}-[a-z]`, 'i') },
  { name: 'build phrasing', re: new RegExp(['this ', 'build'].join(''), 'i') },
  { name: 'pronoun', re: /\b(?:he|she|his|her|hers|him|himself|herself)\b/i },
];
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const DATE_FORMS = [
  { name: 'ISO date', re: /\b20\d\d-\d\d-\d\d\b/ },
  { name: 'month and year', re: new RegExp(`\\b(?:${MONTHS})\\s+(?:\\d{1,2},?\\s+)?20\\d\\d\\b`) },
];

// Dates are judged outside code fences and inline code (examples and samples there are values, not promises).
const stripCode = (text) => stripFences(text).replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));

// -> list of `page:line form`.
export function checkWording({ page, text }) {
  const out = [];
  const prose = stripCode(text).split('\n');
  text.split('\n').forEach((line, i) => {
    for (const f of WORDING_FORMS) if (f.re.test(line)) out.push(`${page}:${i + 1} ${f.name}`);
    for (const f of DATE_FORMS) if (f.re.test(prose[i])) out.push(`${page}:${i + 1} ${f.name}`);
  });
  return out;
}

// cliText: docs/cli.md; commands: the file stems of src/commands. -> the commands without a `### name` section.
export function commandsWithoutSection({ cliText, commands }) {
  const headings = new Set([...cliText.matchAll(/^### ([a-z][a-z-]*)\s*$/gm)].map((m) => m[1]));
  return commands.filter((c) => !headings.has(c));
}

// targets: { page: [lines, reason|null] }; counts: { page: lines }. -> pages outside +/- 40 percent with no reason.
export function lineBoundProblems({ targets, counts }) {
  const out = [];
  for (const [page, [target, reason]] of Object.entries(targets)) {
    const n = counts[page];
    if (n === undefined) { out.push(`${page}: no count`); continue; }
    if (n >= target * 0.6 && n <= target * 1.4) continue;
    if (typeof reason !== 'string' || reason.length < 15) out.push(`${page}: ${n} lines against ${target} with no recorded reason`);
  }
  return out;
}

// The OS-user-name check of docs.test.mjs: the exact clone URL (from package.json repository.url) is removed before the
// name is looked for, so the account segment of that one URL passes and the bare name anywhere else does not.
export function holdsUserName({ text, user, cloneUrl = null }) {
  let t = text;
  if (typeof cloneUrl === 'string' && cloneUrl.length > 0) {
    const bare = cloneUrl.replace(/^git\+/, '').replace(/\.git$/, '');
    for (const form of new Set([cloneUrl, bare, `${bare}.git`])) t = t.split(form).join('');
  }
  return t.toLowerCase().includes(user.toLowerCase());
}
