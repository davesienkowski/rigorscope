// Plan 01-05 Task 2: the strict price-table loader (D-10, T-01-41, T-01-45, T-01-46) and the conformance
// of the shipped table, written before the loader (RED).
//
// The conformance block reads the shipped file with fs and JSON.parse and converts dollars per million
// tokens to nano-dollars per token with Math.round(rate * 1000) itself, importing nothing from src/derive,
// so it is a second signal independent of the loader (those cases are characterization: they pass before
// any loader code exists). One further case loads the same file through loadPrices.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRICES_URL, PRICE_ERROR_CODES, PriceTableError, defaultPricesDir, loadPrices, parsePriceTable,
} from '../../src/derive/price-table.mjs';

const PAGE = 'https://platform.claude.com/docs/en/about-claude/pricing';
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DATA_DIR = join(REPO, 'data');
const NAME_RE = /^prices-\d{4}-\d{2}-\d{2}\.json$/;
const SHIPPED = readdirSync(DATA_DIR).filter((n) => NAME_RE.test(n)).sort().pop();
const SHIPPED_BYTES = readFileSync(join(DATA_DIR, SHIPPED));
const SHIPPED_JSON = JSON.parse(SHIPPED_BYTES.toString('utf8'));
const PLANT = 'CANARY-key-text';

// The JSON form of the fixture table that test/unit/price.test.mjs writes by hand in nano-dollars.
const fixture = () => ({
  schema: 1,
  date_read: '2026-01-01',
  source_url: PAGE,
  reread: false,
  unit: 'usd_per_million_tokens',
  label: 'notional',
  modifiers: { geo_us: { num: 11, den: 10 } },
  models: {
    'test-m': {
      input: 1, cache_write_5m: 1.25, cache_write_1h: 2, cache_read: 0.1, output: 5, status: 'cited',
      fast: { input: 2, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.2, output: 10 },
    },
    'test-t': {
      input: 0.1, cache_write_5m: 0.125, cache_write_1h: 0.2, cache_read: 0.01, output: 0.5, status: 'cited',
      long_prompt: { over_tokens: 100000, input: 0.5, cache_write_5m: 0.625, cache_write_1h: 1, cache_read: 0.05, output: 2.5 },
    },
    'test-f': {
      input: 0.1, cache_write_5m: 0.125, cache_write_1h: 0.2, cache_read: 0.01, output: 0.5, status: 'cited',
      fast: { input: 0.2, cache_write_5m: 0.25, cache_write_1h: 0.4, cache_read: 0.02, output: 1 },
      long_prompt: { over_tokens: 100000, input: 0.5, cache_write_5m: 0.625, cache_write_1h: 1, cache_read: 0.05, output: 2.5 },
    },
  },
  notes: ['a note'],
});
const OPTS = { fileName: 'prices-2026-01-01.json', sha: 'f'.repeat(64) };

const rates = (input, write5m, write1h, read, output) => ({ input, write5m, write1h, read, output });
const T_BASE = rates(100, 125, 200, 10, 500);
const T_LONG = { over: 100000, rates: rates(500, 625, 1000, 50, 2500) };
const EXPECTED_TABLE = {
  models: new Map([
    ['test-m', { ...rates(1000, 1250, 2000, 100, 5000), fast: rates(2000, 2500, 4000, 200, 10000), longPrompt: null }],
    ['test-t', { ...T_BASE, fast: null, longPrompt: T_LONG }],
    ['test-f', { ...T_BASE, fast: rates(200, 250, 400, 20, 1000), longPrompt: T_LONG }],
  ]),
  geoUs: { num: 11, den: 10 },
};

// Deep plain copy (Maps and frozen objects become plain data) for deepEqual.
const plain = (v) => {
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, plain(x)]));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
};

const rejects = (fn, code) => assert.throws(fn, (err) => {
  assert.ok(err instanceof PriceTableError, 'a PriceTableError');
  assert.equal(err.code, code);
  assert.equal(err.message, `price table unusable: ${code}`, 'the message holds the code only');
  return true;
});

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'rigorscope-prices-'));
}

describe('price table module surface', () => {
  it('exports the page URL and a frozen list of eleven distinct fixed error codes', () => {
    assert.equal(PRICES_URL, PAGE);
    assert.ok(Object.isFrozen(PRICE_ERROR_CODES));
    assert.deepEqual([...PRICE_ERROR_CODES].sort(), [
      'bad_dir', 'bad_header', 'bad_json', 'bad_model_key', 'bad_modifier', 'bad_rate', 'bad_schema', 'date_mismatch',
      'file_too_large', 'file_unreadable', 'no_price_file',
    ]);
  });

  it('defaultPricesDir is the absolute data directory beside src, resolved from the module location', () => {
    const dir = defaultPricesDir();
    assert.ok(isAbsolute(dir));
    assert.equal(join(dir, '.'), join(DATA_DIR, '.'));
  });
});

describe('parsePriceTable', () => {
  it('builds the nano-dollar table the pricing tests use, plus file, version, date read, sha and reread', () => {
    const p = parsePriceTable(fixture(), OPTS);
    assert.deepEqual(plain(p.table), plain(EXPECTED_TABLE));
    assert.deepEqual([p.file, p.version, p.dateRead, p.sha, p.reread], ['prices-2026-01-01.json', '2026-01-01', '2026-01-01', 'f'.repeat(64), false]);
  });

  it('looks models up in a Map, so no model id reaches an inherited object property', () => {
    const { table } = parsePriceTable(fixture(), OPTS);
    assert.ok(table.models instanceof Map);
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) assert.equal(table.models.has(id), false);
  });

  const mutate = (fn) => { const o = fixture(); fn(o); return o; };
  const cases = [
    ['a missing top-level key', 'bad_schema', (o) => { delete o.notes; }],
    ['an extra top-level key', 'bad_schema', (o) => { o[PLANT] = 1; }],
    ['an extra key in a model row', 'bad_schema', (o) => { o.models['test-m'][PLANT] = 1; }],
    ['an extra key in a fast row', 'bad_schema', (o) => { o.models['test-m'].fast[PLANT] = 1; }],
    ['an extra key in modifiers', 'bad_modifier', (o) => { o.modifiers[PLANT] = 1; }],
    ['a missing rate', 'bad_rate', (o) => { delete o.models['test-m'].output; }],
    ['a negative rate', 'bad_rate', (o) => { o.models['test-m'].input = -1; }],
    ['a rate with four decimals', 'bad_rate', (o) => { o.models['test-m'].cache_read = 0.1234; }],
    ['a string rate', 'bad_rate', (o) => { o.models['test-m'].input = '1'; }],
    ['a NaN rate', 'bad_rate', (o) => { o.models['test-m'].input = Number.NaN; }],
    ['a model key ending in -YYYYMMDD', 'bad_model_key', (o) => { o.models['test-m-20251001'] = o.models['test-m']; }],
    ['a model key with uppercase letters', 'bad_model_key', (o) => { o.models['Test-X'] = o.models['test-m']; }],
    ['a model key with a space', 'bad_model_key', (o) => { o.models['test x'] = o.models['test-m']; }],
    ['a long_prompt over_tokens that is not a positive integer', 'bad_modifier', (o) => { o.models['test-t'].long_prompt.over_tokens = 1.5; }],
    ['a geo_us with den 0', 'bad_modifier', (o) => { o.modifiers.geo_us.den = 0; }],
    ['a geo_us with non-integers', 'bad_modifier', (o) => { o.modifiers.geo_us.num = 1.1; }],
    ['a date_read that differs from the file name', 'date_mismatch', (o) => { o.date_read = '2026-01-02'; }],
    ['a bad schema number', 'bad_schema', (o) => { o.schema = 2; }],
    ['a row status other than validated or cited', 'bad_schema', (o) => { o.models['test-m'].status = 'guessed'; }],
    ['a wrong unit', 'bad_header', (o) => { o.unit = 'usd_per_token'; }],
    ['a wrong label', 'bad_header', (o) => { o.label = 'measured'; }],
    ['a reread that is not a boolean', 'bad_header', (o) => { o.reread = 'yes'; }],
    ['a source_url that is not an https URL', 'bad_header', (o) => { o.source_url = 'ftp://example.invalid/x'; }],
    ['notes that are not a list of strings', 'bad_header', (o) => { o.notes = [1]; }],
  ];
  for (const [what, code, fn] of cases) {
    it(`parsePriceTable refuses ${what} with code ${code} and no file text in the message`, () => {
      rejects(() => parsePriceTable(mutate(fn), OPTS), code);
    });
  }

  it('parsePriceTable refuses a top-level value that is not an object, and a file name that is not dated', () => {
    for (const v of [null, [], 'x', 1]) rejects(() => parsePriceTable(v, OPTS), 'bad_schema');
    rejects(() => parsePriceTable(fixture(), { ...OPTS, fileName: 'prices.json' }), 'date_mismatch');
  });
});

describe('loadPrices', () => {
  const write = (dir, name, obj) => writeFileSync(join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));
  const dated = (date) => ({ ...fixture(), date_read: date });

  it('picks the bytewise-greatest name matching prices-YYYY-MM-DD.json and ignores other names', () => {
    const dir = tempDir();
    try {
      write(dir, 'prices-2026-01-01.json', dated('2026-01-01'));
      write(dir, 'prices-2026-02-01.json', dated('2026-02-01'));
      write(dir, 'prices-2026-03-01.json.bak', 'not json');
      write(dir, 'prices-2026-4-01.json', 'not json');
      write(dir, 'zz-notes.txt', 'not json');
      const p = loadPrices({ dir });
      assert.deepEqual([p.file, p.version, p.dateRead], ['prices-2026-02-01.json', '2026-02-01', '2026-02-01']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the sha256 of the file bytes it parsed', () => {
    const dir = tempDir();
    try {
      write(dir, 'prices-2026-01-01.json', fixture());
      const bytes = readFileSync(join(dir, 'prices-2026-01-01.json'));
      assert.equal(loadPrices({ dir }).sha, createHash('sha256').update(bytes).digest('hex'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a relative, empty or missing directory with bad_dir', () => {
    rejects(() => loadPrices({ dir: 'data' }), 'bad_dir');
    rejects(() => loadPrices({ dir: '' }), 'bad_dir');
    rejects(() => loadPrices({ dir: join(tmpdir(), 'rigorscope-no-such-dir-0f3a') }), 'bad_dir');
  });

  it('refuses a directory with no matching file with no_price_file', () => {
    const dir = tempDir();
    try {
      write(dir, 'readme.txt', 'x');
      rejects(() => loadPrices({ dir }), 'no_price_file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked newest file with file_unreadable', () => {
    const dir = tempDir();
    const other = tempDir();
    try {
      write(other, 'real.json', fixture());
      symlinkSync(join(other, 'real.json'), join(dir, 'prices-2026-01-01.json'));
      rejects(() => loadPrices({ dir }), 'file_unreadable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses a directory named like a price file with file_unreadable', () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, 'prices-2026-01-01.json'));
      rejects(() => loadPrices({ dir }), 'file_unreadable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file over 262144 bytes with file_too_large before parsing it', () => {
    const dir = tempDir();
    try {
      write(dir, 'prices-2026-01-01.json', `${JSON.stringify(fixture())}${' '.repeat(262145)}`);
      rejects(() => loadPrices({ dir }), 'file_too_large');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses invalid JSON and non-ASCII bytes with bad_json, keeping no excerpt of the input', () => {
    const dir = tempDir();
    try {
      write(dir, 'prices-2026-01-01.json', `{"schema": 1, ${PLANT}`);
      rejects(() => loadPrices({ dir }), 'bad_json');
      write(dir, 'prices-2026-01-01.json', JSON.stringify({ ...fixture(), notes: ['café'] }));
      rejects(() => loadPrices({ dir }), 'bad_json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a hostile key name or note is refused with a fixed code and never echoed', () => {
    const dir = tempDir();
    try {
      write(dir, 'prices-2026-01-01.json', { ...fixture(), [PLANT]: 1 });
      assert.throws(() => loadPrices({ dir }), (err) => !String(err.message).includes(PLANT) && !String(err.stack).includes(PLANT));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('conformance of the shipped table', () => {
  // Every row on the page keeps the 1.25x (5m) and 2x (1h) write multipliers, so no row is an exception.
  const MULTIPLIER_EXCEPTIONS = [];
  const nano = (rate) => Math.round(rate * 1000);
  const five = (r) => [r.input, r.cache_write_5m, r.cache_write_1h, r.cache_read, r.output].map(nano);

  it('source_url is the pricing page, date_read matches the file name and reread is a boolean', () => {
    assert.equal(SHIPPED_JSON.source_url, PAGE);
    assert.equal(SHIPPED, `prices-${SHIPPED_JSON.date_read}.json`);
    assert.equal(typeof SHIPPED_JSON.reread, 'boolean');
  });

  it('the five research-validated rows equal their research values in nano-dollars per token', () => {
    const want = {
      'claude-opus-5-5': [4000, 5000, 8000, 200, 20000],
      'claude-sonnet-5-5': [2000, 2500, 4000, 100, 10000],
      'claude-haiku-5-5': [100, 125, 200, 10, 500],
      'claude-opus-4-8': [5000, 6250, 10000, 500, 25000],
      'claude-fable-5-1': [10000, 12500, 20000, 250, 50000],
    };
    for (const [id, values] of Object.entries(want)) {
      assert.deepEqual(five(SHIPPED_JSON.models[id]), values, id);
      assert.equal(SHIPPED_JSON.models[id].status, 'validated', id);
    }
    const validated = Object.entries(SHIPPED_JSON.models).filter(([, r]) => r.status === 'validated').map(([id]) => id).sort();
    assert.deepEqual(validated, Object.keys(want).sort());
  });

  it('claude-haiku-5-5 has a long_prompt tier over 100000 tokens at 500, 625, 1000, 50, 2500', () => {
    const lp = SHIPPED_JSON.models['claude-haiku-5-5'].long_prompt;
    assert.equal(lp.over_tokens, 100000);
    assert.deepEqual(five(lp), [500, 625, 1000, 50, 2500]);
  });

  it('every row and fast or long row keeps the 1.25x and 2x write multipliers', () => {
    for (const [id, row] of Object.entries(SHIPPED_JSON.models)) {
      if (MULTIPLIER_EXCEPTIONS.includes(id)) continue;
      for (const r of [row, row.fast, row.long_prompt].filter(Boolean)) {
        const [input, w5, w1] = five(r);
        assert.equal(w5 * 4, input * 5, `${id} 5m write is 1.25x input`);
        assert.equal(w1, input * 2, `${id} 1h write is 2x input`);
      }
    }
  });

  it('the dated transcript id claude-haiku-4-5-20251001 resolves to a row, and no key carries a date suffix', () => {
    assert.ok(Object.hasOwn(SHIPPED_JSON.models, 'claude-haiku-4-5-20251001'.replace(/-\d{8}$/, '')));
    for (const id of Object.keys(SHIPPED_JSON.models)) assert.ok(!/-\d{8}$/.test(id), id);
    assert.equal(Object.hasOwn(SHIPPED_JSON.models, 'claude-fable-5-0'), false, 'no fable 5.0 row on the page');
  });

  it('the file is plain ASCII', () => {
    assert.equal([...SHIPPED_BYTES].findIndex((b) => b > 127), -1);
  });

  // A tree without .git (an archive copy, a published tarball) has no index to ask: the bytes were read from disk above.
  it('the file is tracked by git (where the tree has git)', { skip: existsSync(join(REPO, '.git')) ? false : 'no .git in this tree' }, () => {
    const r = spawnSync('git', ['-C', REPO, 'ls-files', '--', `data/${SHIPPED}`], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), `data/${SHIPPED}`);
  });

  it('loadPrices on the shipped directory loads it with its sha and every row', () => {
    const p = loadPrices();
    assert.equal(p.file, SHIPPED);
    assert.equal(p.dateRead, SHIPPED_JSON.date_read);
    assert.equal(p.sha, createHash('sha256').update(SHIPPED_BYTES).digest('hex'));
    assert.deepEqual([...p.table.models.keys()].sort(), Object.keys(SHIPPED_JSON.models).sort());
    const opus = p.table.models.get('claude-opus-5-5');
    assert.deepEqual([opus.input, opus.write5m, opus.write1h, opus.read, opus.output], [4000, 5000, 8000, 200, 20000]);
  });
});
