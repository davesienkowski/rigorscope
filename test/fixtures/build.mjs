// Synthetic fixture generator for rigorscope tests. A helper, not a test: it is never collected by
// the quoted test glob. Everything here is invented; nothing is copied from real transcripts.
//
// Contracts shared by the tests (they are written before the code they cover):
//   - A normalizer is a function normalize(parsedObject) -> { row, rejected }. `row` is null when the
//     line is dropped, else an object holding exactly the cc_message column names (missing = null).
//     `rejected` is a list of column names whose value failed its shape check (names only).
//   - runIngest, rebuildDerived and loadCostReport are exported by their src modules; the CLI is
//     bin/rigorscope.mjs. Tests spawn the CLI with HOME pointing at a fixture home.
//
// All timestamps are fixed, never relative to now.
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, lstatSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as tracerBase from './cases/10-tracer-base.mjs';
import { FIXTURE_NOW } from './clock.mjs';

// Case module contract (every file in test/fixtures/cases/*.mjs; adding a file adds a case, with no
// edit to this file):
//   id        file name without the numeric prefix and extension
//   group     'tracer' (built by buildTranscriptTree, the 01-01 tree) or 'extra'
//   sources   array of source names the case feeds ('transcript' here)
//   build(ctx)  writes the case into ctx.root (or its sibling directories); ctx holds
//             { root, home, plants, windowsUsersDir, helpers }. Case modules never import this file
//             (it imports case 10 statically), they use ctx.helpers.
//   expected  plain data computed by hand: messageKeys ('session|agent|message' -> token tuple
//             [input, output, cache_read, cache_creation, cache_5m, cache_1h], null = unknown),
//             sourceFiles ('alias:relative path'), agentMeta, skipped (walk skips by reason),
//             unknownAttr ('scope|name' -> count), dropped, cwd ('key' -> stored value)
//   options   optional runIngest options the case needs (for example maxLineBytes)
//   verify(ctx)  optional extra assertions

export const BIN = fileURLToPath(new URL('../../bin/rigorscope.mjs', import.meta.url));
export const REPO = fileURLToPath(new URL('../../', import.meta.url));

// Unique strings, each holding the marker CANARY. They are planted in every position a real source
// carries identity or content. Never print one in a failure message: report indexes and offsets.
export const PLANTS = {
  prompt: 'CANARY-prompt summarize the quarterly numbers for the board',
  // The header word is joined at run time so the bearer-header shape does not appear as text in this file.
  command: `CANARY-cmd curl -H 'Authorization: ${['Bear', 'er'].join('')} CANARYtoken0123456789' https://example.invalid/upload`,
  email: 'CANARY-mail@canary-example.invalid',
  account: 'CANARY-acct-0f3a9c11',
  org: 'CANARY-org-77b1d2e4',
  osUser: 'CANARYuser',
  // e-acute and snowman, written as JavaScript escapes so this file stays ASCII.
  nonAscii: 'CANARY caf\u00e9 \u2603 note',
  hostileAgent: 'CANARY agent spaced tok-CANARYsecret77',
  hostileModel: 'model-CANARY-mail@canary-example.invalid',
};

// The same non-ASCII plant as it appears when a JSON writer escapes it.
export const NON_ASCII_ESCAPED = 'CANARY caf\\u00e9 \\u2603 note';

export const ASSISTANT_MARKER = '"type":"assistant"';
export const NEWEST_RECORD_UTC = '2026-10-27T12:00:09.000Z';
export const LABELS_LINE =
  'labels: tokens=transcript notional_usd=unavailable window_share=unavailable; ' +
  '? means unknown (label unavailable), never zero';
// Plan 01-06: the window_share column became window_5h and window_7d (the labels key stays window_share).
export const HEADER_TOKENS = [
  'role', 'model', 'calls', 'input', 'output', 'cache_read', 'cache_write', 'notional_usd', 'window_5h', 'window_7d',
];

// Message ids, session ids and the hand-computed expectations. Computed by hand from the fixture
// below, never by the code under test.
export const SESSION = { s1: 'sess-fixture-s1', s2: 'sess-fixture-s2' };
export const AGENT_ID = 'agent0123456789ab';
export const MSG = {
  m1: 'msg_01m1', m2: 'msg_01m2', m3: 'msg_01m3', m4: 'msg_01m4',
  m5: 'msg_01m5', m6: 'msg_01m6', m7: 'msg_02m7', m8: 'msg_02m8',
};

// The five hand-computed cost rows live beside the tracer case (cases/10-tracer-base.mjs).
export const EXPECTED_COST_ROWS = tracerBase.expected.costRows;

// Ingest counts for the whole tree. candidates = lines holding the assistant marker (9 parsed plus
// 1 truncated). 9 assistant lines make 8 distinct rows (the streaming message takes two lines).
export const EXPECTED_COUNTS = {
  files: 4,
  candidates: 10,
  assistant: 9,
  kept: 9,
  rows: 8,
  unparseable: 1,
  rejected: { attribution_agent: 1, model: 1 },
};

const homePath = (...parts) => ['', 'home', ...parts].join('/');
const mangled = (...parts) => ['', 'home', ...parts].join('-');

export function escapeNonAscii(line) {
  let out = '';
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    if (cp < 128) out += ch;
    else if (cp < 0x10000) out += '\\u' + cp.toString(16).padStart(4, '0');
    else {
      const v = cp - 0x10000;
      out += '\\u' + (0xd800 + (v >> 10)).toString(16) + '\\u' + (0xdc00 + (v & 0x3ff)).toString(16);
    }
  }
  return out;
}

function usage({ input, output, read, creation, c5, c1 }) {
  const u = { input_tokens: input, output_tokens: output, cache_read_input_tokens: read };
  if (creation !== undefined) u.cache_creation_input_tokens = creation;
  if (c5 !== undefined) u.cache_creation = { ephemeral_5m_input_tokens: c5, ephemeral_1h_input_tokens: c1 };
  u.service_tier = 'standard';
  u.speed = 'standard';
  u.inference_geo = 'not_available';
  return u;
}

function assistant({
  session, ts, id, model, use, agentId, attributionAgent, content, cwd, version = '2.1.309', effort = 'high',
}) {
  const o = {
    type: 'assistant',
    uuid: `uuid-${id}-${ts.slice(-7, -5)}`,
    parentUuid: null,
    sessionId: session,
    timestamp: ts,
    requestId: `req_${id}`,
    gitBranch: 'topic/fixture-branch',
    cwd,
    version,
    effort,
  };
  if (agentId !== undefined) { o.agentId = agentId; o.isSidechain = true; }
  if (attributionAgent !== undefined) o.attributionAgent = attributionAgent;
  const message = { id, type: 'message', role: 'assistant' };
  if (model !== undefined) message.model = model;
  message.content = content ?? [{ type: 'text', text: 'ok' }];
  message.usage = use;
  o.message = message;
  return o;
}

// Builders for tests that need their own lines (parsed objects, not JSON text).
export { assistant as makeAssistant, usage as makeUsage };

const T = (sec) => `2026-10-27T12:00:${String(sec).padStart(2, '0')}.000Z`;

// Session S1 (LF endings): non-assistant lines first, then M1..M6, a truncated line and a blank line.
export function session1Lines({ cwd = homePath(PLANTS.osUser, 'work', 'proj') } = {}) {
  const lines = [];
  lines.push(JSON.stringify({
    type: 'user', uuid: 'uuid-user-1', sessionId: SESSION.s1, timestamp: T(0), cwd,
    accountUuid: PLANTS.account,
    message: { role: 'user', content: [{ type: 'text', text: PLANTS.prompt }] },
  }));
  lines.push(JSON.stringify({
    type: 'attachment', uuid: 'uuid-att-1', sessionId: SESSION.s1,
    attachment: { type: 'credential_org', organizationUuid: PLANTS.org },
  }));
  lines.push(JSON.stringify({
    type: 'bridge-session', sessionId: SESSION.s1,
    ownerAccountUuid: PLANTS.account, ownerOrganizationUuid: PLANTS.org,
  }));
  lines.push(JSON.stringify(assistant({
    session: SESSION.s1, ts: T(1), id: MSG.m1, model: 'claude-opus-5-5', cwd,
    use: usage({ input: 120, output: 80, read: 5000, creation: 300, c5: 200, c1: 100 }),
    content: [
      { type: 'text', text: PLANTS.prompt },
      { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: PLANTS.command } },
    ],
  })));
  // Streaming: the same message in two lines, output_tokens grows 10 -> 25.
  lines.push(JSON.stringify(assistant({
    session: SESSION.s1, ts: T(2), id: MSG.m2, model: 'claude-opus-5-5', cwd,
    use: usage({ input: 50, output: 10, read: 1000, creation: 100 }),
  })));
  lines.push(JSON.stringify(assistant({
    session: SESSION.s1, ts: T(3), id: MSG.m2, model: 'claude-opus-5-5', cwd,
    use: usage({ input: 50, output: 25, read: 1000, creation: 100 }),
  })));
  lines.push(JSON.stringify(assistant({
    session: SESSION.s1, ts: T(4), id: MSG.m5, model: 'claude-haiku-5-5', cwd,
    use: usage({ input: 7, output: 0, read: 0, creation: 0 }),
  })));
  lines.push(JSON.stringify(assistant({
    session: SESSION.s1, ts: T(5), id: MSG.m6, cwd, // no message.model
    use: usage({ input: 3, output: 4, read: 5, creation: 6 }),
  })));
  lines.push(JSON.stringify(assistant({
    session: SESSION.s1, ts: T(6), id: MSG.m3, model: 'claude-sonnet-5-5', cwd,
    agentId: AGENT_ID, attributionAgent: 'gsd-executor',
    use: usage({ input: 10, output: 0, read: 200, creation: 30 }),
  })));
  lines.push(JSON.stringify(assistant({
    session: SESSION.s1, ts: T(7), id: MSG.m4, model: 'claude-sonnet-5-5', cwd,
    agentId: AGENT_ID, attributionAgent: 'gsd-executor',
    use: usage({ input: 20, output: 5, read: 400 }), // no cache_creation fields at all
  })));
  // Cut mid-object: holds the assistant marker, cannot parse.
  lines.push('{"type":"assistant","sessionId":"' + SESSION.s1 + '","message":{"id":"msg_01cut","usage":{"input_tokens":1');
  lines.push('');
  return lines;
}

// Session S2 (CRLF endings): hostile attribution agent (M7) and hostile model (M8, non-ASCII escaped).
export function session2Lines({ cwd = homePath(PLANTS.osUser, 'work', 'other') } = {}) {
  const m7 = assistant({
    session: SESSION.s2, ts: T(8), id: MSG.m7, model: 'claude-opus-4-8', cwd,
    attributionAgent: PLANTS.hostileAgent,
    use: usage({ input: 1, output: 1, read: 1, creation: 1 }),
    content: [{ type: 'text', text: PLANTS.nonAscii }],
  });
  const m8 = assistant({
    session: SESSION.s2, ts: T(9), id: MSG.m8, model: PLANTS.hostileModel, cwd,
    use: usage({ input: 1, output: 1, read: 1, creation: 1 }),
    content: [{ type: 'text', text: PLANTS.nonAscii }],
  });
  return [JSON.stringify(m7), escapeNonAscii(JSON.stringify(m8))];
}

export function writeJsonl(file, lines, eol = '\n') {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, lines.length ? lines.join(eol) + eol : '', 'utf8');
}

// Builds the 01-01 tracer tree (case 10) under `root` and returns the four file paths. The root is
// <home>/.claude, so the project directories are named from the mangled fixture home.
export function buildTranscriptTree(root) {
  const ctx = caseContext(root, {});
  return tracerBase.build(ctx);
}

// A fresh HOME whose own name holds the fake OS user name, a space and a hash character.
export function makeHome() {
  const home = mkdtempSync(join(tmpdir(), `rigorscope-${PLANTS.osUser} #home-`));
  const root = join(home, '.claude');
  return { home, root, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// Plan 01-11 (WR-06): the spawned-CLI guard. runCli kills a child that runs longer than timeoutMs (default
// DEFAULT_CLI_TIMEOUT_MS, 180000 ms, with SIGKILL) and THROWS an Error whose message is describeCliFailure(result)
// whenever the child ended by a signal or the spawn reported an error (a timeout kill, a spawn failure, an
// output overflow), unless the caller passes allowSignal: true. Otherwise it returns the spawnSync result
// unchanged. runCliAsync has no timeout and is guarded the same way (onChild(child) is a test seam).
export const DEFAULT_CLI_TIMEOUT_MS = 180_000;
const STDERR_TAIL_CHARS = 2000;

// Failure text from the status, the signal, the error code and the last 2000 characters of stderr. It never
// prints the argument list (an argument can hold a path).
export function describeCliFailure(result) {
  const stderr = String(result?.stderr ?? '');
  const tail = stderr.length > STDERR_TAIL_CHARS ? stderr.slice(-STDERR_TAIL_CHARS) : stderr;
  const cut = stderr.length > STDERR_TAIL_CHARS ? ` (last ${STDERR_TAIL_CHARS} of ${stderr.length} chars)` : '';
  return `rigorscope child failed: status=${result?.status ?? null} signal=${result?.signal ?? null} ` +
    `error=${result?.error?.code ?? null} stderr${cut}:\n${tail}`;
}

export function runCli(args, {
  home, nodeArgs = [], env, timeoutMs = DEFAULT_CLI_TIMEOUT_MS, killSignal = 'SIGKILL', allowSignal = false, cwd = REPO,
} = {}) {
  const result = spawnSync(process.execPath, [...nodeArgs, BIN, ...args], {
    cwd,
    env: env ?? cliEnv(home),
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal,
  });
  if ((result.signal || result.error) && allowSignal !== true) throw new Error(describeCliFailure(result));
  return result;
}

export function runCliAsync(args, {
  home, env, allowSignal = false, onChild, cwd = REPO,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd, env: env ?? cliEnv(home),
    });
    let stdout = '';
    let stderr = '';
    let error = null;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { error = err; });
    child.on('close', (status, signal) => {
      const result = { status, signal, stdout, stderr, ...(error ? { error } : {}) };
      if ((signal || error) && allowSignal !== true) reject(new Error(describeCliFailure(result)));
      else resolve(result);
    });
    if (onChild) onChild(child);
  });
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const sha256File = (file) => sha256(readFileSync(file));

export const stateDirOf = (home) => join(home, '.rigorscope');

export function listState(home) {
  const dir = stateDirOf(home);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

// Content digest of a whole tree (sorted relative paths and file hashes). Used to prove that
// ingest never changes its sources.
export function treeDigest(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(`${relative(dir, p)}:${sha256File(p)}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return sha256(out.join('\n'));
}

// Read-only query against a database file, opened directly (independent of src/db.mjs).
export function queryDb(file, sql, params = []) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...params).map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

// Row count plus a digest of the sorted (key, token columns) tuples of cc_message.
export function storeDigest(home) {
  const rows = queryDb(
    join(stateDirOf(home), 'store.db'),
    `SELECT session_id, agent_id, message_id, input_tokens, output_tokens, cache_read, cache_creation
       FROM cc_message ORDER BY session_id, agent_id, message_id`,
  );
  return { count: rows.length, digest: sha256(JSON.stringify(rows)) };
}

// Plan 01-08: a table body line that is a data row (not a section's =total row and not the totals check line).
export const isDataRow = (l) => !l.startsWith('totals check:') && l.trim().split(/\s+/)[0] !== '=total';

// Splits `cost` stdout into its parts. Rows are split on whitespace. Plan 01-08: `freshness` is the first line of the
// freshness block (the block runs up to the period line) and `period` is the line that starts with "period:".
export function parseCost(stdout) {
  const lines = stdout.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const labelsAt = lines.findIndex((l) => l.startsWith('labels:'));
  const headerAt = lines.findIndex((l) => l.trim().split(/\s+/)[0] === 'role');
  return {
    lines,
    freshness: lines[0],
    period: lines.find((l) => l.startsWith('period:')),
    header: headerAt >= 0 ? lines[headerAt].trim().split(/\s+/) : null,
    rows: headerAt >= 0
      ? lines.slice(headerAt + 1, labelsAt >= 0 ? labelsAt : undefined).filter(isDataRow).map((l) => l.trim().split(/\s+/))
      : [],
    labels: labelsAt >= 0 ? lines[labelsAt] : null,
  };
}

// ---------------------------------------------------------------------------------------------
// 01-02 conventions: auto-loading cases, hermetic child environment, line helpers.
// ---------------------------------------------------------------------------------------------

export const CASES_DIR = fileURLToPath(new URL('./cases/', import.meta.url));

// The mangled form of a path as Claude Code names project directories: every non-alphanumeric
// character becomes a dash. Written by hand here (NOT imported from src) so the test is independent
// of the code under test.
export const mangleHome = (home) => home.replace(/[^A-Za-z0-9]/g, '-');

// Where a fixture HOME keeps its fake Windows users directory.
export const windowsUsersDirFor = (home) => join(home, 'winusers');

// Child environment built from an allowlist. It never inherits CLAUDE_CONFIG_DIR (the executor
// shell may export it) and points the Windows users directory inside the fixture, so a spawned run
// cannot ingest real data.
// Plan 01-08: RIGORSCOPE_NOW is fixed to FIXTURE_NOW and TZ to UTC unless `extra` sets them, so the 7-day default
// window keeps every earlier fixture inside it and no spawned test depends on the machine zone.
export function cliEnv(home, extra = {}) {
  const env = {
    HOME: home, RIGORSCOPE_WINDOWS_USERS_DIR: windowsUsersDirFor(home), RIGORSCOPE_NOW: FIXTURE_NOW, TZ: 'UTC',
  };
  for (const k of ['PATH', 'TMPDIR', 'LANG']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

// Ingests a fixture HOME in this process through the same entry the `ingest` command calls (runIngest with the
// environment's clock and Windows users dir), for tests that need an ingested store and do not test the command
// itself. Saves one node start-up per call; the command's own behavior stays covered by the spawned ingest tests.
export async function ingestHome(home, env = cliEnv(home)) {
  const { runIngest } = await import('../../src/ingest/run.mjs');
  const { clockFromEnv } = await import('../../src/clock.mjs');
  const { windowsUsersDirFromEnv } = await import('../../src/sources/transcript/roots.mjs');
  const r = await runIngest({ home, env, windowsUsersDir: windowsUsersDirFromEnv(env), now: clockFromEnv(env).now });
  if (r.skipped === 'lock_held') throw new Error('ingestHome: another ingest holds the lock in this fixture home');
  return r;
}

export function userLine({ session, ts, text, cwd, extra = {} }) {
  return JSON.stringify({
    type: 'user', uuid: `uuid-user-${ts}`, sessionId: session, timestamp: ts, ...(cwd ? { cwd } : {}), ...extra,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

// Deterministic Fisher-Yates shuffle of the lines of a JSONL file, in place (seeded LCG).
export function shuffleLines(file, seed = 1) {
  const text = readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  let x = seed >>> 0 || 1;
  const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
  for (let i = lines.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }
  writeFileSync(file, lines.join(eol) + eol, 'utf8');
}

export const HELPERS = {
  makeAssistant: assistant, makeUsage: usage, userLine, writeJsonl, shuffleLines, mangleHome, escapeNonAscii,
  session1Lines, session2Lines, T, homePath,
};

// The context handed to a case's build(). home defaults to the parent of root (root = home/.claude).
export function caseContext(root, { home, windowsUsersDir } = {}) {
  const h = home ?? join(root, '..');
  return {
    root, home: h, plants: PLANTS, windowsUsersDir: windowsUsersDir ?? windowsUsersDirFor(h), helpers: HELPERS,
  };
}

// Imports every *.mjs case in dir (default: the shared cases/ directory) sorted by file name and validates the
// contract. A test that needs a throwaway case passes its own temp dir; it never writes into CASES_DIR.
export async function loadCases(dir = CASES_DIR) {
  const names = readdirSync(dir).filter((n) => /^\d+-[a-z0-9-]+\.mjs$/.test(n)).sort();
  const out = [];
  for (const name of names) {
    const mod = await import(pathToFileURL(join(dir, name)).href);
    const want = name.replace(/^\d+-/, '').replace(/\.mjs$/, '');
    if (mod.id !== want) throw new Error(`case ${name} exports id ${mod.id}, expected ${want}`);
    for (const k of ['group', 'sources', 'build', 'expected']) {
      if (mod[k] === undefined) throw new Error(`case ${name} does not export ${k}`);
    }
    out.push({ file: name, ...mod });
  }
  return out;
}

// cases: 'all', a group name ('tracer' | 'extra') or an array of ids.
export async function buildFixtureTree(root, { home, cases = 'all', windowsUsersDir } = {}) {
  const ctx = caseContext(root, { home, windowsUsersDir });
  const all = await loadCases();
  const chosen = all.filter((c) => (
    cases === 'all' || (Array.isArray(cases) ? cases.includes(c.id) : c.group === cases)
  ));
  const built = [];
  for (const c of chosen) built.push({ id: c.id, result: c.build(ctx), case: c });
  return { ctx, built };
}
