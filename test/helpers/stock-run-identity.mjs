// Helper of plan 03.1-05 (ADPT-04, ADPT-05, D-12): the identity scan for the stock-run fixtures and the record rules for the run
// result. A helper, not a test: the quoted test glob never collects it.
//
// The identity values to look for (the needles) are derived at call time from the environment and are never written as
// literals in any committed file. Failure text names a rule id and a byte position, never the matched text or a needle value.
//
// Not detectable by the needle scan (also stated in the maintainer notes): a name that no needle holds (an account display name
// that differs from the git name, an organization name, a nickname or another spelling), a domain that is a mail provider or
// a common top-level label (skipped on purpose, they are not identity), and a one-word name that is also a common word (its
// hits cannot be told from ordinary text, so each hit is scrubbed to a placeholder instead of judged).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { basename } from 'node:path';

export const MIN_NEEDLE = 3;
export const LABEL = 'not stock: global config present';
export const SOFT_USD = 155;
export const HARD_USD = 270;
export const BEFORE_LIMIT_USD = 240;
export const START_BELOW_WEEKLY = 65;
export const STOP_AT_WEEKLY = 70;
export const MAX_STEPS = 21;
export const GROUP_ORDER = ['launch', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'close'];

function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  } catch {
    return '';
  }
}

// Labels that are never identity: top-level and second-level labels and the big mail and hosting providers (a noreply address
// of a code host names the host, not the person).
const GENERIC_LABELS = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'int', 'mil', 'io', 'dev', 'app', 'info', 'biz', 'xyz', 'online', 'site', 'tech', 'cloud',
  'co', 'ac', 'uk', 'de', 'fr', 'nl', 'se', 'no', 'fi', 'dk', 'es', 'it', 'pl', 'ch', 'at', 'be', 'ca', 'au', 'nz', 'jp', 'cn',
  'in', 'br', 'ru', 'us', 'eu', 'me', 'tv', 'ai',
  'users', 'noreply', 'github', 'gitlab', 'bitbucket', 'gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'yahoo', 'icloud',
  'proton', 'protonmail', 'example', 'localhost', 'mail', 'email', 'local', 'internal', 'invalid', 'test', 'www',
]);

const clean = (v) => (v ?? '').trim().toLowerCase();
const uniqSorted = (list) => [...new Set(list)].sort();

// -> { substring, word } from explicit identity values (user, login, home, name, email); the pure core of identityNeedles().
// substring: lower-case strings matched anywhere (at least MIN_NEEDLE characters): the values themselves, each word of the
// name, the email local part, and the email domain with each custom label of 5 or more characters. word: custom domain labels
// of 3 or 4 characters, matched as whole tokens only so that an ordinary word containing the label is not a hit. Top-level and
// provider labels (GENERIC_LABELS) never become needles, and a domain whose labels are all generic gives none.
export function needlesFrom({ user, login, home, name, email } = {}) {
  const substring = [user, login, home, name, ...clean(name).split(/\s+/), email].map(clean);
  const word = [];
  const addr = clean(email);
  const at = addr.indexOf('@');
  if (at !== -1) {
    substring.push(addr.slice(0, at));
    const domain = addr.slice(at + 1);
    const custom = domain.split('.').filter((l) => l.length >= MIN_NEEDLE && !GENERIC_LABELS.has(l));
    if (custom.length > 0) {
      substring.push(domain);
      for (const l of custom) (l.length >= 5 ? substring : word).push(l);
    }
  }
  return {
    substring: uniqSorted(substring.filter((v) => v.length >= MIN_NEEDLE)),
    word: uniqSorted(word.filter((v) => v.length >= MIN_NEEDLE && !substring.includes(v))),
  };
}

// -> the run-time { substring, word } needle sets. Sources: user name, `id -un` login, home directory basename, git user.name
// (whole and each word), git user.email (whole, local part and domain labels). An unset or unreadable source is skipped.
export function identityNeedleSets() {
  let user = '';
  try { user = userInfo().username; } catch { /* unreadable: skipped */ }
  return needlesFrom({
    user,
    login: tryRun('id', ['-un']),
    home: basename(homedir()),
    name: tryRun('git', ['config', '--global', '--get', 'user.name']),
    email: tryRun('git', ['config', '--global', '--get', 'user.email']),
  });
}

export const identityNeedles = () => identityNeedleSets().substring;
export const identityWordNeedles = () => identityNeedleSets().word;

// Home-shaped paths are built from fragments so this source holds no home-shaped literal. Forward-slash roots, Windows drive
// roots and backslash home roots (also JSON-escaped with doubled backslashes), and a root-user path (not inside a longer word).
const seg = (...parts) => ['', ...parts, ''].join('/');
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BS = '\\\\{1,2}';
const HOME_ALT = [
  esc(seg('home')), esc(seg('Users')), `${esc(seg('mnt'))}[a-z]${esc(seg('Users'))}`,
  `[A-Za-z]:${BS}Users${BS}`, `${BS}home${BS}`, `(?<![\\w.~-])${esc(seg('root'))}`,
].join('|');
const HOME_PATH = new RegExp(`(?:${HOME_ALT})[^\\s/\\\\'"\`)]+`, 'g');
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const TOKEN = /[A-Za-z0-9_+/=-]{32,}/g;
const SK = /\bsk-[A-Za-z0-9_-]{8,}/g;
const CLAUDE_AI = /claude\.ai/gi;
// The trailer word is joined from parts so it does not appear as text in this file.
const COAUTHOR = new RegExp(`^${['Co', 'Authored', 'By'].join('-')}:\\s*(.+)$`, 'gim');
const MODEL_NAME = /claude|sonnet|opus|haiku|fable|gpt|gemini|copilot|model/i;
const GIT_IDENT_CONFIG = /\buser\.(?:name|email)\s*[=:]\s*["']?([^\s"']+)/gi;
const GIT_IDENT_LOG = /^(?:Author|Committer|From):\s*(.+)$/gim;

const isExemptToken = (t) => /^[0-9a-f]+$/.test(t) && [7, 12, 40, 64].includes(t.length);
// A relative file path of a planning tree: it has a slash, no base64 padding characters, and every word between slashes and
// dashes is a single-case word, a number or at most 4 characters (v1, m2). Random secrets have longer mixed-case or
// letter-and-digit runs, so they stay tokens. A long slash-free slug is still judged a token.
const isPathShaped = (t) => t.includes('/') && !/[+=]/.test(t)
  && t.split(/[/_-]+/).filter(Boolean).every((w) => w.length <= 4 || /^(?:[a-z]+|[A-Z]+|[0-9]+)$/.test(w));
const looksLikeToken = (t) => /[0-9]/.test(t) && /[A-Za-z]/.test(t) && !isExemptToken(t) && !isPathShaped(t);

// -> [{ rule, pos }]: rule ids with a byte position, never the matched text. needles: lower-case strings matched anywhere
// (identityNeedles()); wordNeedles: lower-case strings matched only as whole tokens (identityWordNeedles()).
export function scanText(text, needles = [], wordNeedles = []) {
  const hits = [];
  const add = (rule, index) => hits.push({ rule, pos: Buffer.byteLength(text.slice(0, index), 'utf8') });
  const lower = text.toLowerCase();
  for (const n of needles) {
    for (let at = lower.indexOf(n); at !== -1; at = lower.indexOf(n, at + n.length)) add('needle', at);
  }
  for (const n of wordNeedles) {
    for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9])${esc(n)}(?![A-Za-z0-9])`, 'gi'))) add('needle', m.index);
  }
  for (const m of text.matchAll(EMAIL)) add('email', m.index);
  for (const m of text.matchAll(UUID)) add('uuid', m.index);
  for (const m of text.matchAll(TOKEN)) if (looksLikeToken(m[0])) add('token', m.index);
  for (const m of text.matchAll(SK)) add('sk', m.index);
  for (const m of text.matchAll(CLAUDE_AI)) add('claude-ai', m.index);
  for (const m of text.matchAll(HOME_PATH)) add('home-path', m.index);
  for (const m of text.matchAll(COAUTHOR)) if (!MODEL_NAME.test(m[1])) add('coauthor', m.index);
  for (const m of text.matchAll(GIT_IDENT_CONFIG)) if (m[1].toLowerCase() !== 'fixture') add('git-identity', m.index);
  for (const m of text.matchAll(GIT_IDENT_LOG)) if (!/^fixture\b/i.test(m[1])) add('git-identity', m.index);
  return hits.sort((a, b) => a.pos - b.pos);
}

export const ruleIds = (hits) => hits.map((h) => h.rule);

// -> a failure message that names the file, the rule and the byte position only.
export const describeHit = (file, hit) => `${file}: rule ${hit.rule} at byte ${hit.pos}`;

// -> one line per hit in a list of file or directory names (relative paths): the digest of the whole name, the rule and the byte
// position, never the name or the matched text.
export function scanNames(names, needles = [], wordNeedles = []) {
  return names.flatMap((name) => scanText(name, needles, wordNeedles).map((hit) => `name ${hitDigest(name)}: rule ${hit.rule} at byte ${hit.pos}`));
}

// -> the first 8 hex characters of the sha256 of a hit (for a message that must identify a value without printing it).
export const hitDigest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 8);

// -> the text with needle hits, home paths, emails, UUIDs, tokens and session-link mentions replaced by placeholders.
export function scrubText(text, needles = [], wordNeedles = []) {
  let out = text;
  for (const n of needles) out = out.replace(new RegExp(esc(n), 'gi'), '<scrubbed>');
  for (const n of wordNeedles) out = out.replace(new RegExp(`(?<![A-Za-z0-9])${esc(n)}(?![A-Za-z0-9])`, 'gi'), '<scrubbed>');
  out = out.replace(HOME_PATH, '~/<scrubbed>');
  out = out.replace(EMAIL, '<email>').replace(UUID, '<uuid>').replace(SK, '<key>').replace(CLAUDE_AI, '<host>');
  out = out.replace(TOKEN, (t) => (looksLikeToken(t) ? '<token>' : t));
  return out;
}

// ---- the run result record --------------------------------------------------------------------------------------------

function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${esc(heading)}\\s*$`, 'i').test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

// -> rows of a markdown table in the section as objects keyed by the header cells; [] when there is no table.
function tableRows(body) {
  if (body === null) return [];
  const lines = body.split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const head = cells(lines[0]);
  return lines.slice(1).filter((l) => !/^\|?\s*:?-{2,}/.test(l.trim())).map((l) => {
    const c = cells(l);
    return Object.fromEntries(head.map((h, i) => [h, c[i] ?? '']));
  });
}

// -> the header cells of the first markdown table in the section; [] when there is no table.
function tableHead(body) {
  if (body === null) return [];
  const first = body.split('\n').find((l) => l.trim().startsWith('|'));
  return first ? first.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()) : [];
}

const num = (v) => {
  const n = Number.parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && /\d/.test(String(v)) ? n : null;
};
const groupIndex = (g) => GROUP_ORDER.indexOf(String(g).trim());

// -> { label, leakHeading, ship, gates, costs, steps, costUnknown, stopReason } parsed from the result text.
export function parseResult(text) {
  const stopBody = section(text, 'Stop reason');
  const stopLine = /^Stop reason:\s*(.+)$/im.exec(text);
  return {
    label: text.split('\n').some((l) => l.includes(LABEL)),
    leakHeading: section(text, 'Leak list') !== null,
    ship: text.split('\n').some((l) => /\/gsd-ship/.test(l) && /not run:/.test(l)),
    gatesHeading: section(text, 'Usage gates') !== null,
    gatesHead: tableHead(section(text, 'Usage gates')),
    gates: tableRows(section(text, 'Usage gates')),
    costHead: tableHead(section(text, 'Cost')),
    costs: tableRows(section(text, 'Cost')),
    steps: tableRows(section(text, 'Steps')),
    costUnknown: /^cost:\s*unknown\s*\(/im.test(text),
    cleanClaim: /(?<!not |never |no )\bclean stock\b/i.test(text),
    stopReason: stopLine ? stopLine[1].trim() : (stopBody ? stopBody.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? null : null),
  };
}

export const GATE_HEADERS = ['group', 'weekly_used', 'level', 'decision'];
export const COST_HEADERS = ['group', 'cumulative_before_usd', 'cumulative_after_usd'];

// -> the sorted rule ids the result text violates ([] for a clean record). Every rule has a generated negative case in
// test/prohibitions/stock-run-fixture-identity.test.mjs.
export function checkResult(text) {
  const r = parseResult(text);
  const bad = new Set();
  if (!r.label) bad.add('label-missing');
  if (!r.leakHeading) bad.add('leak-list-missing');
  if (!r.ship) bad.add('ship-not-marked-not-run');
  if (r.cleanClaim) bad.add('clean-stock-claim');
  if (!r.gatesHeading) bad.add('usage-gates-missing');
  if (r.stopReason === null) bad.add('stop-reason-missing');
  if (r.steps.length > MAX_STEPS) bad.add('too-many-steps');
  // Evidence cannot be removed to switch a rule off: a present gates table needs its columns and at least one row; a Cost table
  // needs its columns and at least one numeric row unless the record states the cost is unknown.
  if (r.gatesHeading) {
    if (!GATE_HEADERS.every((h) => r.gatesHead.includes(h))) bad.add('gates-malformed');
    else if (r.gates.length === 0) bad.add('gates-empty');
  }
  if (!r.costUnknown) {
    if (!COST_HEADERS.every((h) => r.costHead.includes(h))) bad.add(r.costHead.length === 0 ? 'cost-empty' : 'cost-malformed');
    else if (!r.costs.some((c) => num(c.cumulative_before_usd) !== null || num(c.cumulative_after_usd) !== null)) bad.add('cost-empty');
  }
  for (const g of r.gates) {
    const level = (g.level ?? '').toLowerCase();
    const weekly = num(g.weekly_used);
    const decision = (g.decision ?? '').toLowerCase();
    if (decision === 'start' && (!['green', 'reserve'].includes(level) || weekly === null || weekly >= START_BELOW_WEEKLY)) bad.add('start-against-gate');
    if (weekly !== null && weekly >= STOP_AT_WEEKLY && decision !== 'stop') bad.add('no-stop-at-weekly-limit');
  }
  const costRows = r.costs.map((c) => ({ group: c.group, before: num(c.cumulative_before_usd), after: num(c.cumulative_after_usd) }));
  const numericRows = costRows.filter((c) => c.before !== null || c.after !== null);
  if (r.costUnknown && numericRows.length > 0) bad.add('unknown-cost-with-numbers');
  let prev = null;
  for (const c of numericRows) {
    if (c.after !== null && c.after > HARD_USD) bad.add('cost-over-hard-cap');
    if (c.before !== null && c.before > BEFORE_LIMIT_USD) bad.add('group-started-over-allowance');
    if (c.before !== null && c.after !== null && c.after < c.before) bad.add('cost-goes-down');
    if (prev !== null && c.before !== null && c.before < prev) bad.add('cost-goes-down');
    if (c.after !== null) prev = c.after;
  }
  // Soft checkpoint: a Cost row of group k at or past SOFT_USD needs an ask or stop gate row among the gate rows of the later
  // groups before any start row there; with no later start the Stop reason must name the checkpoint or the cap.
  const crossing = numericRows.find((c) => c.after !== null && c.after >= SOFT_USD);
  if (crossing) {
    const later = r.gates.filter((g) => groupIndex(g.group) > groupIndex(crossing.group));
    const firstStart = later.findIndex((g) => (g.decision ?? '').toLowerCase() === 'start');
    const firstBrake = later.findIndex((g) => ['ask', 'stop'].includes((g.decision ?? '').toLowerCase()));
    if (firstStart !== -1 && (firstBrake === -1 || firstBrake > firstStart)) bad.add('crossed-soft-checkpoint-without-ask');
    if (firstStart === -1 && !/soft checkpoint|hard cap|155|270/i.test(r.stopReason ?? '')) bad.add('crossed-soft-checkpoint-without-ask');
  }
  return [...bad].sort();
}
