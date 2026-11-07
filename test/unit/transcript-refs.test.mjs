// Plan 02-04 (D-12 with amendment Q4, D-14, D-24): the planning-file ref extractor of src/sources/transcript/refs.mjs.
// Only the own string properties `file_path`, `path`, `notebook_path` and `pattern` of `tool_use` content entries are
// read; a value yields a ref only when it holds a shape-checked `.planning/quick/` or `.planning/phases/` path whose
// prefix home-normalizes. Written before the code (RED): the module is imported inside each test, so this file loads
// before it exists. Every home here is an explicit synthetic home set, never the process HOME.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHomeSet } from '../../src/sources/transcript/home.mjs';

const load = () => import('../../src/sources/transcript/refs.mjs');
const HOME = '/h/u';
const homeSet = buildHomeSet({ home: HOME });
const line = (blocks) => ({ type: 'assistant', message: { id: 'm', content: blocks } });
const tool = (name, input) => ({ type: 'tool_use', id: 'toolu_x', name, input });
const PLAN = `${HOME}/repos/x/.planning/quick/261030-abc-t/261030-abc-PLAN.md`;

describe('normalizeRefs: the tracer rules', () => {
  it('a Read file_path under HOME gives one home-normalized quick ref', async () => {
    const { normalizeRefs } = await load();
    const { refs } = normalizeRefs(line([tool('Read', { file_path: PLAN })]), { homeSet, cwd: '~/work/beta' });
    assert.deepEqual(refs, [{
      ref_dir: '~/repos/x', rel_path: '.planning/quick/261030-abc-t/261030-abc-PLAN.md', ref_kind: 'quick', tool_name: 'Read', n: 1,
    }]);
  });

  it('a phases path gives ref_kind phase', async () => {
    const { normalizeRefs } = await load();
    const { refs } = normalizeRefs(line([tool('Read', { file_path: `${HOME}/repos/x/.planning/phases/02-demo/02-01-PLAN.md` })]), { homeSet });
    assert.equal(refs.length, 1);
    assert.equal(refs[0].ref_kind, 'phase');
    assert.equal(refs[0].rel_path, '.planning/phases/02-demo/02-01-PLAN.md');
  });

  it('a path outside every home keeps its absolute prefix', async () => {
    const { normalizeRefs } = await load();
    const { refs } = normalizeRefs(line([tool('Glob', { path: '/srv/w/x/.planning/quick/261030-abc-t' })]), { homeSet });
    assert.deepEqual(refs.map((r) => [r.ref_dir, r.rel_path, r.tool_name]), [['/srv/w/x', '.planning/quick/261030-abc-t', 'Glob']]);
  });

  it('a Bash command, a text block, a non-string file_path, a non-planning file_path and a tool_use without input give no ref', async () => {
    const { normalizeRefs } = await load();
    const blocks = [
      tool('Bash', { command: `cat ${PLAN}`, description: `read ${PLAN}` }),
      { type: 'text', text: PLAN },
      tool('Read', { file_path: 42 }),
      tool('Read', { file_path: { nested: PLAN } }),
      tool('Read', { file_path: `${HOME}/repos/x/src/index.mjs` }),
      { type: 'tool_use', id: 'toolu_y', name: 'Read' },
    ];
    const { refs } = normalizeRefs(line(blocks), { homeSet, cwd: '~/work/beta' });
    assert.deepEqual(refs, []);
  });

  it('splitPlanningPath is exported, pure, and gives prefix, kind and segments', async () => {
    const { splitPlanningPath, REF_FIELDS, REF_LIMITS, PATH_SEGMENT_RE, TOOL_NAME_RE } = await load();
    const a = splitPlanningPath(PLAN);
    const b = splitPlanningPath(PLAN);
    assert.deepEqual(a, b);
    assert.deepEqual(a, { prefix: `${HOME}/repos/x`, kind: 'quick', segments: ['261030-abc-t', '261030-abc-PLAN.md'] });
    assert.deepEqual([...REF_FIELDS], ['file_path', 'path', 'notebook_path', 'pattern']);
    assert.ok(Object.isFrozen(REF_FIELDS) && Object.isFrozen(REF_LIMITS));
    assert.equal(REF_LIMITS.maxBlocks, 64);
    assert.equal(REF_LIMITS.maxRefsPerLine, 16);
    assert.ok(PATH_SEGMENT_RE.test('261030-abc-t') && !PATH_SEGMENT_RE.test('a b'));
    assert.ok(TOOL_NAME_RE.test('mcp__srv__tool') && !TOOL_NAME_RE.test('bad name'));
  });
});

// Plan 02-04 Task 2: every ref edge of the [refs rule] truth. Counts are keyed by their ingest_count name (kind
// `capture`): ref_shape, ref_short, ref_unanchored, ref_tool_name, refs_truncated.
describe('normalizeRefs: every edge', () => {
  const winSet = buildHomeSet({ home: HOME, windowsUsers: [{ user: 'u' }] });
  const one = async (input, { name = 'Read', cwd = '~/work/beta', set = homeSet } = {}) => {
    const { normalizeRefs } = await load();
    return normalizeRefs(line([tool(name, input)]), { homeSet: set, cwd });
  };

  it('a relative path is joined to the normalized cwd; without a cwd it is unanchored', async () => {
    assert.deepEqual((await one({ path: '.planning/phases/02-demo' }, { name: 'Grep' })).refs,
      [{ ref_dir: '~/work/beta', rel_path: '.planning/phases/02-demo', ref_kind: 'phase', tool_name: 'Grep', n: 1 }]);
    assert.equal((await one({ path: 'sub/dir/.planning/phases/02-demo' })).refs[0].ref_dir, '~/work/beta/sub/dir');
    const none = await one({ path: '.planning/phases/02-demo' }, { cwd: null });
    assert.deepEqual(none.refs, []);
    assert.deepEqual(none.counts, { ref_unanchored: 1 });
  });

  it('a drive-letter Windows path under a known profile gives a ~win dir and a posix rel_path', async () => {
    const r = await one({ file_path: ['C:', 'Users', 'u', 'code', 'w', '.planning', 'quick', '261029-c2d-w', '261029-c2d-PLAN.md'].join('\\') }, { set: winSet });
    assert.deepEqual(r.refs.map((x) => [x.ref_dir, x.rel_path]), [['~win/code/w', '.planning/quick/261029-c2d-w/261029-c2d-PLAN.md']]);
  });

  it('a backslash outside a drive-letter value, a wildcard, a space or .. in the prefix and free text give ref_shape', async () => {
    for (const v of [
      'a\\b\\.planning\\quick\\261030-a1b-x', `${HOME}/a*b/.planning/quick/261030-a1b-x`, `${HOME}/a b/.planning/quick/261030-a1b-x`,
      `${HOME}/repos/../x/.planning/quick/261030-a1b-x`,
    ]) {
      const r = await one({ file_path: v });
      assert.deepEqual([r.refs, r.counts], [[], { ref_shape: 1 }], 'a shape-failing prefix');
    }
    // Review WR-02: a Grep `pattern` is a content regex, never read, so it is not even counted.
    const grep = await one({ pattern: 'grep free text .planning/quick/261030-a1b-first-task' }, { name: 'Grep' });
    assert.deepEqual([grep.refs, grep.counts], [[], {}]);
  });

  it('pattern is read only for Glob, anchored to its own path field before the cwd (review WR-02)', async () => {
    const regex = await one({ pattern: 'auth-bypass/.planning/phases/fix-secret-token-leak' }, { name: 'Grep' });
    assert.deepEqual([regex.refs, regex.counts], [[], {}], 'a Grep regex is never a planning path');
    const other = await one({ pattern: '.planning/quick/261030-a1b-x' }, { name: 'Search' });
    assert.deepEqual([other.refs, other.counts], [[], {}], 'pattern of a tool other than Glob is not read');
    const abs = await one({ pattern: '.planning/phases/02-foo/*.md', path: `${HOME}/repos/alpha` }, { name: 'Glob' });
    assert.deepEqual(abs.refs, [{ ref_dir: '~/repos/alpha', rel_path: '.planning/phases/02-foo', ref_kind: 'phase', tool_name: 'Glob', n: 1 }],
      'a relative pattern is anchored to an absolute path field');
    const rel = await one({ pattern: '.planning/quick/261030-a1b-x/*.md', path: 'sub/' }, { name: 'Glob' });
    assert.equal(rel.refs[0]?.ref_dir, '~/work/beta/sub', 'a relative path field is joined to the cwd first');
    const dot = await one({ pattern: '.planning/quick/261030-a1b-x/*.md', path: '.' }, { name: 'Glob' });
    assert.equal(dot.refs[0]?.ref_dir, '~/work/beta', 'path `.` is the cwd');
    const noPath = await one({ pattern: '.planning/quick/261030-a1b-x/*.md' }, { name: 'Glob' });
    assert.equal(noPath.refs[0]?.ref_dir, '~/work/beta', 'no path field: the cwd');
    const relNoCwd = await one({ pattern: '.planning/quick/261030-a1b-x/*.md', path: 'sub' }, { name: 'Glob', cwd: null });
    assert.deepEqual([relNoCwd.refs, relNoCwd.counts], [[], { ref_unanchored: 1 }]);
    const absPattern = await one({ pattern: `${HOME}/repos/x/.planning/quick/261030-a1b-x/*.md`, path: `${HOME}/repos/alpha` }, { name: 'Glob' });
    assert.equal(absPattern.refs[0]?.ref_dir, '~/repos/x', 'an absolute pattern ignores the path field');
    const badPath = await one({ pattern: '.planning/quick/261030-a1b-x/*.md', path: `${HOME}/a b` }, { name: 'Glob' });
    assert.deepEqual([badPath.refs, badPath.counts], [[], { ref_shape: 1 }], 'a shape-failing path field is never replaced by the cwd');
  });

  it('a Glob path of ./ or with . segments or doubled slashes normalizes like . and /, never dropped or mis-anchored (review WR-07)', async () => {
    const P = '.planning/quick/261030-a1b-x/*.md';
    const dirOf = async (path) => {
      const r = await one({ pattern: P, path }, { name: 'Glob' });
      return [r.refs[0]?.ref_dir, r.counts];
    };
    assert.deepEqual(await dirOf('./'), ['~/work/beta', {}], '`./` is the cwd like `.`');
    assert.deepEqual(await dirOf('.//'), ['~/work/beta', {}], '`.//` is the cwd');
    assert.deepEqual(await dirOf('././'), ['~/work/beta', {}], 'repeated ./ is the cwd');
    assert.deepEqual(await dirOf('./sub'), ['~/work/beta/sub', {}], 'a leading ./ is dropped');
    assert.deepEqual(await dirOf('sub/./x'), ['~/work/beta/sub/x', {}], 'a middle . segment is dropped');
    assert.deepEqual(await dirOf('sub/.'), ['~/work/beta/sub', {}], 'a trailing . segment is dropped');
    assert.deepEqual(await dirOf('sub//x'), ['~/work/beta/sub/x', {}], 'a doubled slash is one slash');
    assert.deepEqual(await dirOf(`${HOME}/repos/./alpha/`), ['~/repos/alpha', {}], 'an absolute path with a . segment');
    assert.deepEqual(await dirOf('//'), [undefined, { ref_shape: 1 }], '`//` anchors to the root like `/`, which is not a repo directory');
    assert.deepEqual(await dirOf('/'), [undefined, { ref_shape: 1 }], '`/` is the root');
    assert.deepEqual(await dirOf('../x'), [undefined, { ref_shape: 1 }], 'a .. segment is still rejected');
    const noCwd = await one({ pattern: P, path: './' }, { name: 'Glob', cwd: null });
    assert.deepEqual([noCwd.refs, noCwd.counts], [[], { ref_unanchored: 1 }], '`./` with no cwd is unanchored like `.`');
  });

  it('a glob after phases/ is short; a path is cut at its first shape-failing segment', async () => {
    const g = await one({ pattern: '.planning/phases/02-*/*-PLAN.md' }, { name: 'Glob' });
    assert.deepEqual([g.refs, g.counts], [[], { ref_short: 1 }]);
    assert.equal((await one({ file_path: '.planning/quick/261030-a1b-x/a b/c' })).refs[0].rel_path, '.planning/quick/261030-a1b-x');
  });

  it('two blocks naming one rel_path give n 2; 65 blocks scan 64; 17 distinct refs keep 16', async () => {
    const { normalizeRefs, REF_LIMITS } = await load();
    const two = normalizeRefs(line([tool('Read', { file_path: PLAN }), tool('Read', { file_path: PLAN })]), { homeSet });
    assert.deepEqual(two.refs.map((r) => r.n), [2]);
    const filler = Array.from({ length: REF_LIMITS.maxBlocks }, () => ({ type: 'text', text: 'x' }));
    assert.deepEqual(normalizeRefs(line([...filler, tool('Read', { file_path: PLAN })]), { homeSet }).refs, []);
    assert.equal(normalizeRefs(line([...filler.slice(1), tool('Read', { file_path: PLAN })]), { homeSet }).refs.length, 1);
    const many = Array.from({ length: 17 }, (_, i) => tool('Read', { file_path: `${HOME}/r/.planning/quick/261030-a${String(i).padStart(2, '0')}-x` }));
    const kept = normalizeRefs(line(many), { homeSet });
    assert.equal(kept.refs.length, REF_LIMITS.maxRefsPerLine);
    assert.deepEqual(kept.counts, { refs_truncated: 1 });
  });

  it('one rel_path under two directories gives two refs; two tools for one ref keep the bytewise-minimum name (review CR-01)', async () => {
    const { normalizeRefs } = await load();
    const rel = '.planning/quick/261030-abc-t/261030-abc-PLAN.md';
    const r = normalizeRefs(line([
      tool('Read', { file_path: `${HOME}/repos/x/${rel}` }),
      tool('Read', { file_path: `${HOME}/repos/y/${rel}` }),
      tool('Edit', { file_path: `${HOME}/repos/x/${rel}` }),
    ]), { homeSet });
    assert.deepEqual(r.refs.map((x) => [x.ref_dir, x.rel_path, x.tool_name, x.n]), [
      ['~/repos/x', rel, 'Edit', 2],
      ['~/repos/y', rel, 'Read', 1],
    ]);
  });

  it('a hostile tool name drops the ref and is counted ref_tool_name', async () => {
    const r = await one({ file_path: PLAN }, { name: 'bad name; rm' });
    assert.deepEqual([r.refs, r.counts], [[], { ref_tool_name: 1 }]);
  });
});

// Plan 02-04 Task 2 (D-14): the slash-command name picker. A row has exactly five keys; arguments, tool_result text
// and every other text are never returned.
describe('normalizeCommandLine', () => {
  const S = 'sess-cmd-1';
  const userObj = (content, extra = {}) => ({
    type: 'user', sessionId: S, uuid: 'uuid-c-1', timestamp: '2026-10-27T16:00:01.000Z', message: { role: 'user', content }, ...extra,
  });
  const TEXT = '<command-message>gsd-quick</command-message>\n<command-name>/gsd-quick</command-name>\n<command-args>secret args</command-args>';

  it('string content gives a row with only the five keys and the bare command name', async () => {
    const { normalizeCommandLine, COMMAND_NAME_RE } = await load();
    assert.ok(COMMAND_NAME_RE instanceof RegExp);
    const r = normalizeCommandLine(userObj(TEXT), { agentId: undefined });
    assert.deepEqual(r, {
      row: { session_id: S, agent_id: '', uuid: 'uuid-c-1', ts_utc: '2026-10-27T16:00:01.000Z', command_name: 'gsd-quick' },
    });
    assert.ok(!JSON.stringify(r).includes('secret args'));
  });

  it('an array of text blocks works, and a subagent line takes the agentId of the line or of the unit', async () => {
    const { normalizeCommandLine } = await load();
    const r = normalizeCommandLine(userObj([{ type: 'text', text: TEXT }], { agentId: 'agentcmd0000001' }), { agentId: 'agentunit000002' });
    assert.equal(r.row.agent_id, 'agentcmd0000001');
    assert.equal(normalizeCommandLine(userObj([{ type: 'text', text: TEXT }]), { agentId: 'agentunit000002' }).row.agent_id, 'agentunit000002');
    assert.equal(normalizeCommandLine(userObj(TEXT, { timestamp: 'yesterday' }), {}).row.ts_utc, null);
  });

  it('reads the name only at the start of the text, after optional whitespace and one command-message element (review WR-04)', async () => {
    const { normalizeCommandLine } = await load();
    const name = (content) => normalizeCommandLine(userObj(content), {}).row?.command_name ?? normalizeCommandLine(userObj(content), {}).reason;
    assert.equal(name('<command-name>/clear</command-name>'), 'clear');
    assert.equal(name(' \n\t<command-name>/clear</command-name>'), 'clear', 'leading whitespace');
    assert.equal(name('  <command-message>gsd-quick</command-message>\n<command-name>/gsd-quick</command-name>'), 'gsd-quick');
    assert.equal(name('<command-name>/clear</command-name><command-args><command-name>other</command-name></command-args>'), 'clear',
      'a tag inside the arguments never changes the name');
    assert.equal(name('please explain <command-name>/rm-rf-prod</command-name> tag'), 'unanchored', 'prose quoting the tag');
    assert.equal(name('<command-args>a</command-args><command-name>/gsd-q</command-name>'), 'unanchored', 'arguments before the name');
    assert.equal(name(`<command-message>${'m'.repeat(257)}</command-message><command-name>/gsd-q</command-name>`), 'unanchored',
      'a command-message element over 256 characters');
    assert.equal(name([{ type: 'text', text: 'see this:' }, { type: 'text', text: '<command-name>/gsd-q</command-name>' }]), 'unanchored',
      'a tag in a later text block after prose');
    assert.equal(name([{ type: 'text', text: '<command-name>/gsd-q</command-name>' }, { type: 'text', text: 'more' }]), 'gsd-q');
  });

  it('a tag that is well formed but not at the anchored start is its own count-only reason, distinct from no_name (review WR-06)', async () => {
    const { normalizeCommandLine } = await load();
    const out = (content) => normalizeCommandLine(userObj(content), {});
    const unanchored = out('see <command-name>/secret-name</command-name> in the log');
    assert.deepEqual(unanchored, { reason: 'unanchored' }, 'no row and no name in the result');
    assert.ok(!JSON.stringify(unanchored).includes('secret-name'), 'no text in the reason');
    assert.deepEqual(out('<command-name>/gsd-quick extra words</command-name>'), { reason: 'no_name' }, 'a name followed by words stays no_name');
    assert.deepEqual(out('<command-name></command-name>'), { reason: 'no_name' }, 'an empty tag stays no_name');
    assert.deepEqual(out('<command-name>/clear'), { reason: 'no_name' }, 'an unclosed tag stays no_name');
    assert.deepEqual(out('plain prose, no tag'), { reason: 'no_name' }, 'no tag at all stays no_name');
    assert.equal(out('<command-name>/clear</command-name>').row.command_name, 'clear', 'an anchored tag is still a command');
  });

  it('gives a reason, never a row, for a tool_result, a name with words after it, other block types and bad ids', async () => {
    const { normalizeCommandLine } = await load();
    const reason = (obj, ctx = {}) => normalizeCommandLine(obj, ctx).reason;
    assert.equal(reason(userObj([{ type: 'tool_result', tool_use_id: 't', content: TEXT }])), 'tool_result');
    assert.equal(reason(userObj('<command-name>/gsd-quick extra words</command-name>')), 'no_name');
    assert.equal(reason(userObj([{ type: 'image', source: {} }, { type: 'text', text: TEXT }])), 'no_text');
    assert.equal(reason({ ...userObj(TEXT), type: 'system' }), 'not_user');
    const { uuid: _u, ...noUuid } = userObj(TEXT);
    assert.equal(reason(noUuid), 'dropped');
    assert.equal(reason(userObj(TEXT, { sessionId: 'bad session id' })), 'dropped');
    assert.equal(reason(userObj(TEXT, { agentId: 'bad agent id' })), 'dropped');
    for (const obj of [userObj([{ type: 'tool_result', content: TEXT }]), userObj('<command-name>/gsd-quick extra words</command-name>'), noUuid]) {
      const out = JSON.stringify(normalizeCommandLine(obj, {}));
      assert.ok(!out.includes('secret args') && !out.includes('extra words'), 'no text in a reason');
    }
  });
});
