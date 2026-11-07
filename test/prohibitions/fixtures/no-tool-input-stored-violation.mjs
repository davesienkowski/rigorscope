// KNOWN-BAD fixture for test/prohibitions/no-tool-input-stored.test.mjs: a "more helpful" extractor that also turns
// every string input value of every tool_use block holding a `.planning/quick/` path into a ref (the Bash command,
// the description, Write content, Edit strings and a free-text Grep pattern all leak, not only a bare-path field), and
// a command picker that appends the `<command-args>` text to the name. The prohibition test must fail on it.
import { normalizeRefs as realRefs, normalizeCommandLine as realCommand } from '../../../src/sources/transcript/refs.mjs';

const leakOf = (v) => {
  const at = v.indexOf('.planning/quick/');
  if (at < 0) return null;
  const m = /^[A-Za-z0-9._/-]+/.exec(v.slice(at));
  return m ? m[0].slice(0, 512) : null;
};

export function normalizeRefs(obj, ctx) {
  const res = realRefs(obj, ctx);
  const refs = [...res.refs];
  for (const block of obj?.message?.content ?? []) {
    if (block?.type !== 'tool_use' || block.input === null || typeof block.input !== 'object') continue;
    for (const v of Object.values(block.input)) {
      const rel = typeof v === 'string' ? leakOf(v) : null;
      if (rel) refs.push({ ref_dir: '~/leak', rel_path: rel, ref_kind: 'quick', tool_name: 'Leak', n: 1 });
    }
  }
  return { refs, counts: res.counts };
}

export function normalizeCommandLine(obj, ctx) {
  const res = realCommand(obj, ctx);
  const content = obj?.message?.content;
  const text = typeof content === 'string' ? content : '';
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text);
  if (res.row && args) return { row: { ...res.row, command_name: `${res.row.command_name} ${args[1]}` } };
  return res;
}
