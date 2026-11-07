// The versioned price table (plan 01-05, D-10, T-01-41, T-01-45, T-01-46, T-01-48).
//
// A price table is a repo data file `data/prices-YYYY-MM-DD.json`, named by the day the pricing page was
// read. loadPrices picks the bytewise-greatest name matching that pattern in one directory (the shipped
// data directory, resolved from this module's location and never from the cwd, or an absolute directory
// the caller names), refuses a symlink, a non-regular file and a file over 256 KiB, reads the bytes once,
// hashes the same bytes with sha256 and hands the parsed object to parsePriceTable.
//
// parsePriceTable is a strict validator: exactly the documented keys at every level, rates as finite
// non-negative numbers with at most three decimals (so every rate is a whole number of nano-dollars per
// token), model keys of the id shape with no date suffix, a date_read equal to the file-name date. Any
// deviation throws a PriceTableError whose message is the fixed code only: no key, value or parser text
// from the file is ever kept (JSON.parse messages quote their input, so they are discarded).
//
// This module issues no network call and writes nothing. The table it returns:
//   { table: { models: Map(id -> rates), geoUs: { num, den } }, file, version, dateRead, sha, reread }
//   rates: { input, write5m, write1h, read, output, fast: rates5 | null, longPrompt: { over, rates } | null }
// all in nano-dollars per token. Models live in a Map, so no id can reach an inherited object property.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRICES_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';

export const PRICE_ERROR_CODES = Object.freeze([
  'bad_dir', 'no_price_file', 'file_unreadable', 'file_too_large', 'bad_json', 'bad_schema', 'bad_header',
  'bad_model_key', 'bad_rate', 'bad_modifier', 'date_mismatch',
]);

export class PriceTableError extends Error {
  constructor(code) {
    super(`price table unusable: ${code}`);
    this.name = 'PriceTableError';
    this.code = code;
  }
}

const fail = (code) => { throw new PriceTableError(code); };

export const PRICE_FILE_RE = /^prices-(\d{4}-\d{2}-\d{2})\.json$/;
export const MAX_PRICE_FILE_BYTES = 262144;

const TOP_KEYS = ['schema', 'date_read', 'source_url', 'reread', 'unit', 'label', 'modifiers', 'models', 'notes'];
const RATE_KEYS = ['input', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output'];
const ROW_KEYS = [...RATE_KEYS, 'status', 'fast', 'long_prompt'];
const LONG_KEYS = ['over_tokens', ...RATE_KEYS];
const MODEL_KEY_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const DATE_SUFFIX_RE = /-\d{8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^https:\/\/[\x21-\x7e]{1,200}$/;
const SHA_RE = /^[0-9A-Za-z_-]{1,128}$/;
// A rate is dollars per million tokens; 1,000,000 dollars per million tokens is the sanity ceiling.
const MAX_RATE = 1e6;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keysExactly = (obj, allowed, required = allowed) => {
  const keys = Object.keys(obj);
  return keys.every((k) => allowed.includes(k)) && required.every((k) => Object.hasOwn(obj, k));
};
const extraKey = (obj, allowed) => Object.keys(obj).some((k) => !allowed.includes(k));

export function defaultPricesDir() {
  return fileURLToPath(new URL('../../data/', import.meta.url));
}

// Dollars per million tokens -> nano-dollars per token (x 1000), refusing anything that is not a finite,
// non-negative number with at most three decimals.
function nanoRate(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_RATE) fail('bad_rate');
  const n = Math.round(v * 1000);
  if (Math.abs(v * 1000 - n) > 1e-6 || !Number.isSafeInteger(n)) fail('bad_rate');
  return n;
}

function fiveRates(obj) {
  for (const k of RATE_KEYS) if (!Object.hasOwn(obj, k)) fail('bad_rate');
  return Object.freeze({
    input: nanoRate(obj.input),
    write5m: nanoRate(obj.cache_write_5m),
    write1h: nanoRate(obj.cache_write_1h),
    read: nanoRate(obj.cache_read),
    output: nanoRate(obj.output),
  });
}

function parseModel(row) {
  if (!isPlainObject(row) || extraKey(row, ROW_KEYS)) fail('bad_schema');
  if (!['validated', 'cited'].includes(row.status)) fail('bad_schema');
  const base = fiveRates(row);
  let fast = null;
  if (Object.hasOwn(row, 'fast')) {
    if (!isPlainObject(row.fast) || extraKey(row.fast, RATE_KEYS)) fail('bad_schema');
    fast = fiveRates(row.fast);
  }
  let longPrompt = null;
  if (Object.hasOwn(row, 'long_prompt')) {
    const lp = row.long_prompt;
    if (!isPlainObject(lp) || extraKey(lp, LONG_KEYS)) fail('bad_schema');
    if (!Number.isSafeInteger(lp.over_tokens) || lp.over_tokens <= 0) fail('bad_modifier');
    longPrompt = Object.freeze({ over: lp.over_tokens, rates: fiveRates(lp) });
  }
  return Object.freeze({ ...base, fast, longPrompt });
}

function parseModifiers(mod) {
  if (!isPlainObject(mod) || !keysExactly(mod, ['geo_us'])) fail('bad_modifier');
  const g = mod.geo_us;
  if (!isPlainObject(g) || !keysExactly(g, ['num', 'den'])) fail('bad_modifier');
  if (!Number.isSafeInteger(g.num) || !Number.isSafeInteger(g.den) || g.num <= 0 || g.den <= 0 || g.num > 1000 || g.den > 1000) {
    fail('bad_modifier');
  }
  return Object.freeze({ num: g.num, den: g.den });
}

// obj: the parsed JSON value. fileName: the bare file name (its date is the table version). sha: the
// content hash recorded in derive_state.
export function parsePriceTable(obj, { fileName, sha } = {}) {
  if (!isPlainObject(obj) || !keysExactly(obj, TOP_KEYS)) fail('bad_schema');
  if (obj.schema !== 1) fail('bad_schema');
  if (typeof obj.date_read !== 'string' || !DATE_RE.test(obj.date_read)) fail('bad_header');
  if (typeof obj.source_url !== 'string' || !URL_RE.test(obj.source_url)) fail('bad_header');
  if (typeof obj.reread !== 'boolean') fail('bad_header');
  if (obj.unit !== 'usd_per_million_tokens' || obj.label !== 'notional') fail('bad_header');
  if (!Array.isArray(obj.notes) || obj.notes.length > 100 || !obj.notes.every((n) => typeof n === 'string' && n.length <= 2000)) {
    fail('bad_header');
  }
  const m = typeof fileName === 'string' ? PRICE_FILE_RE.exec(fileName) : null;
  if (!m || m[1] !== obj.date_read) fail('date_mismatch');
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) fail('bad_header');
  const geoUs = parseModifiers(obj.modifiers);
  if (!isPlainObject(obj.models)) fail('bad_schema');
  const models = new Map();
  for (const id of Object.keys(obj.models)) {
    if (id.length > 64 || !MODEL_KEY_RE.test(id) || DATE_SUFFIX_RE.test(id)) fail('bad_model_key');
  }
  for (const [id, row] of Object.entries(obj.models)) models.set(id, parseModel(row));
  return Object.freeze({
    table: Object.freeze({ models, geoUs }),
    file: fileName,
    version: m[1],
    dateRead: obj.date_read,
    sha,
    reread: obj.reread,
  });
}

// dir: an absolute directory; undefined means the shipped data directory.
export function loadPrices({ dir } = {}) {
  const where = dir === undefined ? defaultPricesDir() : dir;
  if (typeof where !== 'string' || where.length === 0 || !isAbsolute(where)) fail('bad_dir');
  let names;
  try {
    names = readdirSync(where);
  } catch {
    fail('bad_dir');
  }
  const matching = names.filter((n) => PRICE_FILE_RE.test(n)).sort();
  if (matching.length === 0) fail('no_price_file');
  const name = matching[matching.length - 1];
  const file = join(where, name);
  let st;
  try {
    st = lstatSync(file);
  } catch {
    fail('file_unreadable');
  }
  if (!st.isFile() || st.isSymbolicLink()) fail('file_unreadable');
  if (st.size > MAX_PRICE_FILE_BYTES) fail('file_too_large');
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    fail('file_unreadable');
  }
  if (bytes.length > MAX_PRICE_FILE_BYTES) fail('file_too_large');
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
  return parsePriceTable(obj, { fileName: name, sha });
}
