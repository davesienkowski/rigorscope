// The RPT-01 report filters and the --link-confidence mode (plan 02-07, D-19, D-02, D-13, CONTEXT Q2). `units` uses them
// here; plan 02-08 reuses this module for `tier` and `cost`. Every SQL fragment is built only from the frozen whitelists
// below and every value is a bound parameter; a bad value is a RangeError with one fixed message per flag that never
// echoes the value (callers turn it into a usage error, exit 2, before any state is touched).
//
// Unit filters select units; call filters select calls: a unit is listed when it has an attributed call matching them,
// and its cost counts only those calls. `?` means unknown (NULL) for repo, tier, runtime and model; for role it means the
// stored unknown (review 02-07 WR-04: api_call.role is NOT NULL and an unresolved role is the string `unknown` with
// role_source `unavailable`), so `--role ?` selects role_source = 'unavailable' and `--role unknown` stays valid.
//
// --repo matches repo names and repo keys, not the display: 02-02 displays a repo by its name when exactly one key
// carries it and by its key otherwise, so every displayed repo can be selected, and CONTEXT Q2 names repo_name as the
// value filters use. A name (`^[A-Za-z0-9._-]{1,64}$`) selects every repo of that name; a key (first character `~` or
// `/`) selects exactly one. Inside a key `%2C` stands for a comma and `%25` for a percent sign (the comma separates list
// values); any other `%` is a shape failure. An absolute key element is home-normalized with 02-02's key rule
// (normalizeCwd against HOME, then against the realpath of HOME), because the shell expands an unquoted `~`.
import { realpathSync } from 'node:fs';
import { buildHomeSet, normalizeCwd } from '../sources/transcript/home.mjs';

export const MAX_FILTER_VALUES = 16;
export const REPO_KEY_COLUMNS = Object.freeze(['u.repo_key', 'c.repo_key']);
const SHAPES = Object.freeze({
  tier: /^[ABC]$/,
  framework: /^[a-z][a-z0-9-]{0,31}$/,
  runtime: /^[a-z][a-z0-9-]{0,31}$/,
  model: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}(\[[A-Za-z0-9]{1,16}\])?$/,
  role: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/,
});
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_KEY = 1024;

export const UNIT_FILTERS = Object.freeze({
  repo: Object.freeze({ column: 'u.repo_key', nullable: true }),
  tier: Object.freeze({ column: 'u.tier', nullable: true }),
  framework: Object.freeze({ column: 'u.framework', nullable: false }),
  runtime: Object.freeze({ column: 'u.runtime', nullable: true }),
});
export const CALL_FILTERS = Object.freeze({
  model: Object.freeze({ column: 'c.model', nullable: true }),
  role: Object.freeze({ column: 'c.role', nullable: true, unknownSql: "c.role_source = 'unavailable'" }),
});
export const FILTER_OPTIONS = Object.freeze({
  repo: { type: 'string' },
  tier: { type: 'string' },
  framework: { type: 'string' },
  runtime: { type: 'string' },
  model: { type: 'string' },
  role: { type: 'string' },
  'link-confidence': { type: 'string' },
});

const MESSAGES = Object.freeze({
  repo: `the --repo value must be a comma-separated list of at most ${MAX_FILTER_VALUES} distinct repo names, repo keys (starting with ~ or /, %2C for a comma, %25 for a percent sign) or ?`,
  tier: `the --tier value must be a comma-separated list of at most ${MAX_FILTER_VALUES} distinct values from A, B, C and ?`,
  framework: `the --framework value must be a comma-separated list of at most ${MAX_FILTER_VALUES} distinct framework names`,
  runtime: `the --runtime value must be a comma-separated list of at most ${MAX_FILTER_VALUES} distinct runtime names or ?`,
  model: `the --model value must be a comma-separated list of at most ${MAX_FILTER_VALUES} distinct model names or ?`,
  role: `the --role value must be a comma-separated list of at most ${MAX_FILTER_VALUES} distinct role names or ?`,
});
const MODE_MESSAGE = 'the --link-confidence value must be medium or low';

function decodeKey(text, fail) {
  if (/%(?![2][Cc5])/.test(text) || /%2(?![Cc5])/.test(text)) return fail();
  const out = text.replace(/%2[Cc]/g, ',').replace(/%25/g, '%');
  if (out.length < 1 || out.length > MAX_KEY || CONTROL.test(out)) return fail();
  return out;
}

function homeKey(value, home) {
  if (typeof home !== 'string' || home === '' || !value.startsWith('/')) return value;
  const homes = [home];
  try {
    const real = realpathSync(home);
    if (real !== home) homes.push(real);
  } catch {
    // a failed realpath uses HOME alone
  }
  for (const h of homes) {
    const n = normalizeCwd(value, buildHomeSet({ home: h }));
    if (n !== null && n !== value) return n;
  }
  return value;
}

function parseOne(name, text, home) {
  const fail = () => { throw new RangeError(MESSAGES[name]); };
  if (typeof text !== 'string' || text === '') return fail();
  const parts = text.split(',');
  if (parts.length > MAX_FILTER_VALUES) return fail();
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    if (p === '') return fail();
    let v;
    if (p === '?') {
      if (name === 'framework') return fail();
      v = null;
    } else if (name === 'repo') {
      if (p.startsWith('~') || p.startsWith('/')) v = homeKey(decodeKey(p, fail), home);
      else if (NAME_RE.test(p)) v = p;
      else return fail();
    } else {
      if (!SHAPES[name].test(p)) return fail();
      v = p;
    }
    const k = v === null ? '\u0000null' : v;
    if (seen.has(k)) return fail();
    seen.add(k);
    out.push(v);
  }
  return out;
}

// args: the parsed flags (repo, tier, framework, runtime, model, role: strings or undefined); home: the command's HOME.
// -> { unit: { repo, tier, framework, runtime }, call: { model, role } }: each an array of values (null for ?) or null.
export function parseFilters(args = {}, { home } = {}) {
  const pick = (names) => Object.fromEntries(names.map((n) => [n, args[n] === undefined ? null : parseOne(n, args[n], home)]));
  return { unit: pick(Object.keys(UNIT_FILTERS)), call: pick(Object.keys(CALL_FILTERS)) };
}

export function parseLinkConfidence(text) {
  if (text === undefined) return 'medium';
  if (text === 'medium' || text === 'low') return text;
  throw new RangeError(MODE_MESSAGE);
}

// One filter: `col IN (?, ...)` for the values, `col IS NULL` for ?, OR-joined. The repo filter goes through the fixed
// subquery of repoFilterSql.
export function repoFilterSql(column, values) {
  if (!REPO_KEY_COLUMNS.includes(column)) throw new RangeError('the repo filter column is not whitelisted');
  const known = values.filter((v) => v !== null);
  const parts = [];
  const params = [];
  if (known.length > 0) {
    const list = known.map(() => '?').join(', ');
    parts.push(`${column} IN (SELECT repo_key FROM repo_label WHERE repo_name IN (${list}) OR repo_key IN (${list}))`);
    params.push(...known, ...known);
  }
  if (values.some((v) => v === null)) parts.push(`${column} IS NULL`);
  return { sql: `(${parts.join(' OR ')})`, params };
}

function filterSql(spec, filters, repoColumn) {
  const parts = [];
  const params = [];
  for (const [name, def] of Object.entries(spec)) {
    const values = filters?.[name];
    if (values === null || values === undefined) continue;
    if (name === 'repo') {
      const r = repoFilterSql(repoColumn, values);
      parts.push(r.sql);
      params.push(...r.params);
      continue;
    }
    const known = values.filter((v) => v !== null);
    const or = [];
    if (known.length > 0) { or.push(`${def.column} IN (${known.map(() => '?').join(', ')})`); params.push(...known); }
    if (values.some((v) => v === null)) or.push(def.unknownSql ?? `${def.column} IS NULL`);
    parts.push(`(${or.join(' OR ')})`);
  }
  return parts.length === 0 ? null : { sql: parts.join(' AND '), params };
}

// -> { sql, params } over the unit alias u, or null with no unit filter.
export const unitFilterSql = (filters) => filterSql(UNIT_FILTERS, filters?.unit, 'u.repo_key');
// -> { sql, params } over the call alias c, or null with no call filter.
export const callFilterSql = (filters) => filterSql(CALL_FILTERS, filters?.call, 'c.repo_key');

const escKey = (v) => v.replace(/%/g, '%25').replace(/,/g, '%2C');
const listText = (name, values) => `${name}=${values.map((v) => (v === null ? '?' : (name === 'repo' ? escKey(v) : v))).join(',')}`;
// -> { unit: 'none' | 'repo=a,b tier=A,?', call: 'none' | 'model=x role=main' }, in fixed name order.
export function describeFilters(filters) {
  const text = (part, names) => {
    const items = names.filter((n) => part?.[n] !== null && part?.[n] !== undefined).map((n) => listText(n, part[n]));
    return items.length === 0 ? 'none' : items.join(' ');
  };
  return { unit: text(filters?.unit, Object.keys(UNIT_FILTERS)), call: text(filters?.call, Object.keys(CALL_FILTERS)) };
}

// Plan 02-08 (RPT-01, D-19): `cost` and `tier` build their filter fragments over their own aliases. valueFilterSql is one
// filter over one column: `col IN (?, ...)` for the values and the unknown fragment (default `col IS NULL`) for ?, OR-joined.
// filterSqlFor joins the fragments of the active filters with AND in the fixed order repo, tier, framework, runtime, model,
// role, taking each from `columns`, a caller-supplied frozen map of filter name to a function of the parsed values returning
// { sql, params }; a filter with no entry in the map is a programming error. -> { sql, params } or null with no filter.
export function valueFilterSql(column, values, unknownSql = null) {
  const known = values.filter((v) => v !== null);
  const or = [];
  const params = [];
  if (known.length > 0) { or.push(`${column} IN (${known.map(() => '?').join(', ')})`); params.push(...known); }
  if (values.some((v) => v === null)) or.push(unknownSql ?? `${column} IS NULL`);
  return { sql: `(${or.join(' OR ')})`, params };
}

export const FILTER_NAMES = Object.freeze([...Object.keys(UNIT_FILTERS), ...Object.keys(CALL_FILTERS)]);
// The filter flags without --link-confidence (`cost` has no link-confidence mode: a row key carries none).
export const FILTER_ONLY_OPTIONS = Object.freeze(Object.fromEntries(Object.entries(FILTER_OPTIONS).filter(([k]) => k !== 'link-confidence')));

// opts is passed to each column function as its second argument (cost passes { includeInferred } to the tier filter).
export function filterSqlFor(filters, columns, opts = {}) {
  const parts = [];
  const params = [];
  for (const name of FILTER_NAMES) {
    const values = Object.hasOwn(UNIT_FILTERS, name) ? filters?.unit?.[name] : filters?.call?.[name];
    if (values === null || values === undefined) continue;
    if (typeof columns?.[name] !== 'function') throw new RangeError('a filter has no column in this report');
    const r = columns[name](values, opts);
    parts.push(r.sql);
    params.push(...r.params);
  }
  return parts.length === 0 ? null : { sql: parts.join(' AND '), params };
}
