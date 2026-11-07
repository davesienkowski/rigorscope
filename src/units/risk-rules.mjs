// The versioned risk-rule table (plan 02-03, D-05, D-06; copied from the price-table pattern of
// src/derive/price-table.mjs, threats T-02-23 and T-02-24).
//
// A risk-rule table is a repo data file `data/risk-rules-YYYY-MM-DD.json`. loadRiskRules picks the bytewise-greatest
// name matching that pattern in one directory (the shipped data directory, resolved from this module's location and
// never from the cwd, or an absolute directory the caller names), refuses a symlink, a non-regular file and a file
// over MAX_RISK_RULES_FILE_BYTES, reads the bytes once, refuses a byte above 127, hashes the same bytes with sha256 and
// hands the parsed object to parseRiskRules.
//
// parseRiskRules is a strict validator: exactly the documented keys at every level (a rule may add `not`), the
// vocabulary equal to RISK_TAGS of src/units/risk.mjs, every tag inside it, unique rule ids of a fixed shape, patterns
// of at most MAX_PATTERN_CHARS characters that compile with flag `i` only (no other flag), and a version equal to the
// file-name date. Any deviation throws a RiskRulesError whose message is the fixed code only: no key, value, pattern or
// parser text from the file is ever kept.
//
// The table it returns (frozen):
//   { version, vocabulary, excludePrefixes, rules: [{ id, tag, re, not }], docsOnly: { id, re },
//     scriptUnless: { id, specific }, file, sha }
// The sha is for derive staleness (plan 02-05 records it as the risk_rules_sha stale reason). This module issues no
// network call and writes nothing. To change a rule, add a new dated file and score it on the training labels; a
// shipped file is never edited.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RISK_TAGS } from './risk.mjs';

export const RISK_RULES_FILE_RE = /^risk-rules-(\d{4}-\d{2}-\d{2})\.json$/;
export const MAX_RISK_RULES_FILE_BYTES = 65536;
export const MAX_PATTERN_CHARS = 200;
export const RISK_RULES_ERROR_CODES = Object.freeze([
  'bad_dir', 'no_rules_file', 'file_unreadable', 'file_too_large', 'bad_json', 'bad_schema', 'bad_rule', 'version_mismatch',
]);

export class RiskRulesError extends Error {
  constructor(code) {
    super(`risk rules unusable: ${code}`);
    this.name = 'RiskRulesError';
    this.code = code;
  }
}

const fail = (code) => { throw new RiskRulesError(code); };

const TOP_KEYS = ['schema', 'version', 'vocabulary', 'exclude_prefixes', 'rules', 'docs_only', 'script_unless', 'notes'];
const RULE_KEYS = ['id', 'tag', 'match', 'flags'];
const DOCS_KEYS = ['id', 'tag', 'match', 'flags'];
const UNLESS_KEYS = ['id', 'tag', 'specific'];
const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RULES = 200;
const MAX_PREFIXES = 16;
const MAX_NOTES_CHARS = 4000;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keysExactly = (obj, allowed, required = allowed) => {
  const keys = Object.keys(obj);
  return keys.every((k) => allowed.includes(k)) && required.every((k) => Object.hasOwn(obj, k));
};

export function defaultRiskRulesDir() {
  return fileURLToPath(new URL('../../data/', import.meta.url));
}

// A pattern source and its flags -> a compiled RegExp; anything else is bad_rule.
function compile(source, flags) {
  if (typeof source !== 'string' || source.length === 0 || source.length > MAX_PATTERN_CHARS) fail('bad_rule');
  if (flags !== 'i') fail('bad_rule');
  let re;
  try {
    re = new RegExp(source, flags);
  } catch {
    re = null;
  }
  if (re === null) fail('bad_rule');
  return re;
}

function checkId(id, ids) {
  if (typeof id !== 'string' || !ID_RE.test(id) || ids.has(id)) fail('bad_rule');
  ids.add(id);
}

// obj: the parsed JSON value. fileName: the bare file name (its date is the table version). sha: the content hash.
export function parseRiskRules(obj, { fileName, sha } = {}) {
  if (!isPlainObject(obj) || !keysExactly(obj, TOP_KEYS)) fail('bad_schema');
  if (obj.schema !== 1) fail('bad_schema');
  if (typeof obj.version !== 'string' || !DATE_RE.test(obj.version)) fail('bad_schema');
  if (!Array.isArray(obj.vocabulary) || obj.vocabulary.length !== RISK_TAGS.length
    || !obj.vocabulary.every((t, i) => t === RISK_TAGS[i])) fail('bad_schema');
  if (!Array.isArray(obj.exclude_prefixes) || obj.exclude_prefixes.length > MAX_PREFIXES
    || !obj.exclude_prefixes.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 64)) fail('bad_schema');
  if (typeof obj.notes !== 'string' || obj.notes.length > MAX_NOTES_CHARS) fail('bad_schema');
  if (!Array.isArray(obj.rules) || obj.rules.length === 0 || obj.rules.length > MAX_RULES) fail('bad_schema');
  const m = typeof fileName === 'string' ? RISK_RULES_FILE_RE.exec(fileName) : null;
  if (!m) fail('version_mismatch');
  if (m[1] !== obj.version) fail('version_mismatch');
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) fail('bad_schema');

  const vocab = new Set(RISK_TAGS);
  const ids = new Set();
  const rules = [];
  for (const r of obj.rules) {
    if (!isPlainObject(r) || !keysExactly(r, [...RULE_KEYS, 'not'], RULE_KEYS)) fail('bad_rule');
    checkId(r.id, ids);
    if (!vocab.has(r.tag)) fail('bad_rule');
    const re = compile(r.match, r.flags);
    const not = Object.hasOwn(r, 'not') ? compile(r.not, r.flags) : null;
    rules.push(Object.freeze({ id: r.id, tag: r.tag, re, not }));
  }
  const d = obj.docs_only;
  if (!isPlainObject(d) || !keysExactly(d, DOCS_KEYS)) fail('bad_rule');
  checkId(d.id, ids);
  if (d.tag !== 'docs') fail('bad_rule');
  const docsOnly = Object.freeze({ id: d.id, re: compile(d.match, d.flags) });
  const u = obj.script_unless;
  if (!isPlainObject(u) || !keysExactly(u, UNLESS_KEYS)) fail('bad_rule');
  checkId(u.id, ids);
  if (u.tag !== 'script') fail('bad_rule');
  if (!Array.isArray(u.specific) || u.specific.length === 0
    || !u.specific.every((t) => vocab.has(t) && t !== 'script') || new Set(u.specific).size !== u.specific.length) fail('bad_rule');
  const scriptUnless = Object.freeze({ id: u.id, specific: Object.freeze([...u.specific]) });

  return Object.freeze({
    version: obj.version,
    vocabulary: Object.freeze([...obj.vocabulary]),
    excludePrefixes: Object.freeze([...obj.exclude_prefixes]),
    rules: Object.freeze(rules),
    docsOnly,
    scriptUnless,
    file: fileName,
    sha,
  });
}

// dir: an absolute directory; undefined means the shipped data directory.
export function loadRiskRules({ dir } = {}) {
  const where = dir === undefined ? defaultRiskRulesDir() : dir;
  if (typeof where !== 'string' || where.length === 0 || !isAbsolute(where)) fail('bad_dir');
  let names;
  try {
    names = readdirSync(where);
  } catch {
    fail('bad_dir');
  }
  const matching = names.filter((n) => RISK_RULES_FILE_RE.test(n)).sort();
  if (matching.length === 0) fail('no_rules_file');
  const name = matching[matching.length - 1];
  const file = join(where, name);
  let st;
  try {
    st = lstatSync(file);
  } catch {
    fail('file_unreadable');
  }
  if (!st.isFile() || st.isSymbolicLink()) fail('file_unreadable');
  if (st.size > MAX_RISK_RULES_FILE_BYTES) fail('file_too_large');
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    fail('file_unreadable');
  }
  if (bytes.length > MAX_RISK_RULES_FILE_BYTES) fail('file_too_large');
  // The table is plain ASCII; a byte above 127 is refused before parsing.
  for (const b of bytes) if (b > 127) fail('bad_json');
  let obj;
  try {
    obj = JSON.parse(bytes.toString('ascii'));
  } catch {
    // The parser message quotes the input: it is dropped, only the fixed code is kept.
    obj = undefined;
  }
  if (obj === undefined) fail('bad_json');
  const sha = createHash('sha256').update(bytes).digest('hex');
  return parseRiskRules(obj, { fileName: name, sha });
}
