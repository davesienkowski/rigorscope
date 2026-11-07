// Planning-file references of an assistant line (plan 02-04, D-12 with amendment Q4, D-14, ADR-0009, ADR-0002).
//
// What is read: for each of the first REF_LIMITS.maxBlocks entries of `message.content` whose `type` is `tool_use`,
// the entry's `name` and the own string properties `file_path`, `path`, `notebook_path` and `pattern` of its
// `input` object (REF_FIELDS), by literal name; `pattern` only when the name is `Glob` (review WR-02). Nothing else of
// the line is read here.
//
// What is never read: every other input field, among them a Bash `command` and `description`, Write `content`, Edit
// `old_string` and `new_string`, the `pattern` of Grep or any tool other than Glob (a content regex, not a path),
// every text, thinking and tool_result block. A planning path inside a Bash command
// string is not a ref (amendment Q4: no command text, ADR-0002).
//
// Only a shape-checked planning path leaves this module: a value yields a ref only when it holds a `.planning/quick/`
// or `.planning/phases/` split point (at the start of the value or right after a `/`), every segment of the
// directory before it passes PATH_SEGMENT_RE after home normalization, and at least one segment after `quick/` or
// `phases/` passes it. The ref is { ref_dir, rel_path, ref_kind, tool_name, n }: ref_dir the home-normalized
// directory (`~`, `~win`, `~other` with optional segments, or an absolute posix path), rel_path `.planning/quick/...`
// or `.planning/phases/...` cut at the first segment that fails the shape, ref_kind `quick` or `phase`, tool_name the
// bytewise-smallest name of the entries that named it, n how many tool_use fields of this line named the (ref_dir,
// rel_path) pair (review CR-01: refs merge by directory and path, never by path alone). A value that names a planning
// path but fails a rule is counted by reason name (`ref_shape`, `ref_short`, `ref_unanchored`, `ref_tool_name`,
// `refs_truncated`); no value, path or name is ever put in a count or an error.
//
// The slash-command name picker (D-14): normalizeCommandLine reads a parsed `user` line whose `message.content` is a
// string or an array of only `text` blocks, and keeps the COMMAND_NAME_RE match at the start of that text (the string,
// or the blocks joined by a newline; at most the first 65536 characters; review WR-04) without its slash, plus the line's sessionId, uuid, agentId and timestamp, each shape-checked with the
// id and timestamp shapes of normalize.mjs. `<command-args>` text and every other text are never kept; a line holding a
// tool_result block is never a command. -> { row } with exactly session_id, agent_id, uuid, ts_utc, command_name, or
// { reason } (not_user, tool_result, no_text, no_name, unanchored, dropped).
import { normalizeCwd } from './home.mjs';
import { ID_RE, TIMESTAMP_RE } from './normalize.mjs';

export const REF_FIELDS = Object.freeze(['file_path', 'path', 'notebook_path', 'pattern']);
export const REF_LIMITS = Object.freeze({
  maxBlocks: 64, maxRefsPerLine: 16, maxValueChars: 4096, maxRelPathChars: 512, maxRefDirChars: 1024,
});
// A path segment: letters, digits, `.`, `_` and `-`, 1 to 128 characters, never `.`, never holding `..`.
export const PATH_SEGMENT_RE = /^(?!\.$)(?!.*\.\.)[A-Za-z0-9._-]{1,128}$/;
export const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const MARKERS = Object.freeze([
  Object.freeze({ text: '.planning/quick/', kind: 'quick', dir: 'quick' }),
  Object.freeze({ text: '.planning/phases/', kind: 'phase', dir: 'phases' }),
]);
const CONTROL = /[\u0000-\u001f\u007f]/;
const DRIVE_ANY = /^[A-Za-z]:[\\/]/;
const ROOT = /^(?:~|~win|~other)(?:\/(.*))?$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => (isObject(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const namesPlanning = (v) => MARKERS.some((m) => v.includes(m.text));

// value -> null (not a planning value: no marker anywhere), { reject: 'shape' | 'short' }, or
// { prefix, kind, segments }. Pure: depends on the value only.
export function splitPlanningPath(value) {
  if (typeof value !== 'string') return null;
  if (!namesPlanning(value.replace(/\\/g, '/'))) return null;
  if (value.length > REF_LIMITS.maxValueChars || CONTROL.test(value)) return { reject: 'shape' };
  if (value.includes('\\')) {
    // A backslash only in a drive-letter absolute value; then every backslash becomes `/`.
    if (!/^[A-Za-z]:\\/.test(value)) return { reject: 'shape' };
    return splitPlanningPath(value.replace(/\\/g, '/'));
  }
  let found = null;
  for (let i = value.indexOf('.planning/'); i !== -1 && found === null; i = value.indexOf('.planning/', i + 1)) {
    if (i > 0 && value[i - 1] !== '/') continue;
    const m = MARKERS.find((x) => value.startsWith(x.text, i));
    if (m) found = { at: i, marker: m };
  }
  if (found === null) return { reject: 'shape' };
  let prefix = value.slice(0, found.at);
  if (prefix.length > 1 && prefix.endsWith('/')) prefix = prefix.slice(0, -1);
  const segments = [];
  let len = found.marker.text.length;
  for (const s of value.slice(found.at + found.marker.text.length).split('/')) {
    if (!PATH_SEGMENT_RE.test(s)) break;
    const add = (segments.length > 0 ? 1 : 0) + s.length;
    if (len + add > REF_LIMITS.maxRelPathChars) break;
    segments.push(s);
    len += add;
  }
  if (segments.length === 0) return { reject: 'short' };
  return { prefix, kind: found.marker.kind, segments };
}

const isAbsolute = (p) => p.startsWith('/') || p === '~' || p.startsWith('~/') || DRIVE_ANY.test(p);
const joinDir = (base, rel) => {
  if (rel === '') return base;
  return base === '/' ? `/${rel}` : `${base.replace(/\/+$/, '')}/${rel}`;
};

// The directory a relative prefix is joined to, or { reject }. For a Glob `pattern` (review WR-02) it is the Glob's own
// `path` field when that is a non-empty string other than `.`, after the normalization of `./`, `.` segments and `//`
// (review WR-07): an absolute path is home-normalized like a cwd, a relative one is joined to the line's normalized cwd. Otherwise, and for every other field, it is the line's
// normalized cwd; without a usable cwd a relative anchor is `unanchored`.
function anchorOf({ homeSet, cwd } = {}, globPath) {
  const hasCwd = typeof cwd === 'string' && cwd !== '';
  if (typeof globPath === 'string' && globPath !== '') {
    if (globPath.length > REF_LIMITS.maxValueChars) return { reject: 'shape' };
    // Review WR-07: `.` spellings and doubled slashes normalize before the form is classified, so `./` and `sub/./x`
    // read like `.` and `sub/x`, and `//` is the root like `/`.
    let p = globPath.replace(/\/{2,}/g, '/');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    p = p.replace(/^(?:\.\/)+/, '').replace(/\/\.(?=\/|$)/g, '');
    if (p !== '' && p !== '.') {
      if (isAbsolute(p)) {
        const dir = normalizeCwd(p, homeSet);
        return dir === null ? { reject: 'shape' } : { dir };
      }
      return hasCwd ? { dir: joinDir(cwd, p) } : { reject: 'unanchored' };
    }
  }
  return hasCwd ? { dir: cwd } : { reject: 'unanchored' };
}

// The home-normalized directory of a split prefix, or { reject }. An absolute prefix (`/...`, `~`, `~/...` or a
// drive letter) is home-normalized like a cwd; a relative one (including the empty prefix) is joined to its anchor
// (anchorOf: the Glob's own path field for a Glob pattern, else the line's normalized cwd).
function refDirOf(prefix, ctx = {}, globPath = undefined) {
  let dir;
  if (isAbsolute(prefix)) dir = normalizeCwd(prefix, ctx.homeSet);
  else {
    const a = anchorOf(ctx, globPath);
    if (a.reject) return a;
    dir = joinDir(a.dir, prefix);
  }
  if (dir === null || dir.length > REF_LIMITS.maxRefDirChars) return { reject: 'shape' };
  const t = ROOT.exec(dir);
  let rest;
  if (t) rest = t[1];
  else if (dir.startsWith('/') && dir.length > 1) rest = dir.slice(1);
  else return { reject: 'shape' };
  if (rest !== undefined && !rest.split('/').every((s) => PATH_SEGMENT_RE.test(s))) return { reject: 'shape' };
  return { dir };
}

// obj: the parsed assistant line; ctx: { homeSet, cwd } (cwd: the line's already normalized cwd).
// -> { refs, counts }: refs in first-seen order, merged by (ref_dir, rel_path) with n counted and the bytewise-smallest
// tool_name kept (tool names are ASCII by TOOL_NAME_RE, so `<` is bytewise); counts maps reason names to numbers.
export function normalizeRefs(obj, ctx = {}) {
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] ?? 0) + 1; };
  const content = own(own(obj, 'message'), 'content');
  if (!Array.isArray(content)) return { refs: [], counts };
  const byRel = new Map();
  const limit = Math.min(content.length, REF_LIMITS.maxBlocks);
  for (let i = 0; i < limit; i += 1) {
    const entry = content[i];
    if (own(entry, 'type') !== 'tool_use') continue;
    const input = own(entry, 'input');
    if (!isObject(input)) continue;
    const name = own(entry, 'name');
    for (const field of REF_FIELDS) {
      // Review WR-02: `pattern` is a path glob only for Glob; a Grep pattern is a content regex and is never read.
      if (field === 'pattern' && name !== 'Glob') continue;
      const value = own(input, field);
      if (typeof value !== 'string') continue;
      const sp = splitPlanningPath(value);
      if (sp === null) continue;
      if (sp.reject) { bump(`ref_${sp.reject}`); continue; }
      const d = refDirOf(sp.prefix, ctx, field === 'pattern' ? own(input, 'path') : undefined);
      if (d.reject) { bump(`ref_${d.reject}`); continue; }
      if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) { bump('ref_tool_name'); continue; }
      const marker = MARKERS.find((m) => m.kind === sp.kind);
      const relPath = `.planning/${marker.dir}/${sp.segments.join('/')}`;
      const key = `${d.dir}\0${relPath}`;
      const seen = byRel.get(key);
      if (seen) {
        seen.n += 1;
        if (name < seen.tool_name) seen.tool_name = name;
      } else if (byRel.size >= REF_LIMITS.maxRefsPerLine) bump('refs_truncated');
      else byRel.set(key, { ref_dir: d.dir, rel_path: relPath, ref_kind: sp.kind, tool_name: name, n: 1 });
    }
  }
  return { refs: [...byRel.values()], counts };
}

// Anchored at the start of the text (review WR-04): optional whitespace, at most one `<command-message>` element of up
// to 256 characters with no `<`, optional whitespace, then the name. A real slash-command line starts this way; a
// prompt that quotes or pastes the tag after other text is never a command.
export const COMMAND_NAME_RE =
  /^\s*(?:<command-message>[^<]{0,256}<\/command-message>\s*)?<command-name>\/?([A-Za-z0-9][A-Za-z0-9:_.-]{0,63})<\/command-name>/;
// The same tag shape anywhere in the text (review WR-06): a well-formed tag that fails the anchor is `unanchored`, a
// count-only reason, so a real command line the anchor misses is visible apart from lines with no tag shape.
const COMMAND_TAG_ANYWHERE_RE = /<command-name>\/?[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}<\/command-name>/;
const COMMAND_SCAN_CHARS = 65536;

// obj: the parsed user line; ctx: { agentId } (the unit's agent id for a subagent file, else undefined).
export function normalizeCommandLine(obj, ctx = {}) {
  if (own(obj, 'type') !== 'user') return { reason: 'not_user' };
  const content = own(own(obj, 'message'), 'content');
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && content.length > 0) {
    if (content.some((b) => own(b, 'type') === 'tool_result')) return { reason: 'tool_result' };
    if (!content.every((b) => own(b, 'type') === 'text' && typeof own(b, 'text') === 'string')) return { reason: 'no_text' };
    text = content.map((b) => b.text).join('\n');
  } else return { reason: 'no_text' };
  const scanned = text.slice(0, COMMAND_SCAN_CHARS);
  const m = COMMAND_NAME_RE.exec(scanned);
  if (!m) return { reason: COMMAND_TAG_ANYWHERE_RE.test(scanned) ? 'unanchored' : 'no_name' };
  const sessionId = own(obj, 'sessionId');
  const uuid = own(obj, 'uuid');
  if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) return { reason: 'dropped' };
  if (typeof uuid !== 'string' || !ID_RE.test(uuid)) return { reason: 'dropped' };
  const lineAgent = own(obj, 'agentId');
  let agentId = '';
  if (lineAgent !== undefined && lineAgent !== null) {
    // An agentId that is present but invalid would silently merge into the main thread: the line is dropped.
    if (typeof lineAgent !== 'string' || !ID_RE.test(lineAgent)) return { reason: 'dropped' };
    agentId = lineAgent;
  } else if (typeof ctx.agentId === 'string' && ID_RE.test(ctx.agentId)) agentId = ctx.agentId;
  const ts = own(obj, 'timestamp');
  return {
    row: {
      session_id: sessionId,
      agent_id: agentId,
      uuid,
      ts_utc: typeof ts === 'string' && TIMESTAMP_RE.test(ts) ? ts : null,
      command_name: m[1],
    },
  };
}
