// A deliberately leaking stand-in for the planning-ref extractor (plan 02-04). The canary self-test injects it into
// runIngest (option extractRefs) to prove the raw-byte scan finds tool input text that reaches cc_message_ref: for
// every tool_use block, any string input value holding `.planning/quick/` (a Bash command, file content, a free-text
// pattern, not only a path field) gives a ref whose rel_path starts at that substring and is cut at the first character
// outside [A-Za-z0-9._/-]. Every leaked row passes migration 007's CHECKs and foreign key, so the self-test can fail
// only by finding the needle, never by a constraint error. It must not import anything from src/.
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function relOf(value) {
  const at = value.indexOf('.planning/quick/');
  if (at < 0) return null;
  const m = /^[A-Za-z0-9._/-]+/.exec(value.slice(at));
  if (!m) return null;
  const rel = m[0].slice(0, 512).replace(/\/+$/, '');
  if (rel.includes('..') || rel.includes('//') || rel.length <= '.planning/quick/'.length) return null;
  return rel;
}

export function leakyExtractRefs(obj) {
  const content = isObject(obj) && isObject(obj.message) && Array.isArray(obj.message.content) ? obj.message.content : [];
  const byRel = new Map();
  for (const block of content) {
    if (!isObject(block) || block.type !== 'tool_use' || !isObject(block.input)) continue;
    const toolName = typeof block.name === 'string' && TOOL_NAME.test(block.name) ? block.name : 'Leak';
    for (const v of Object.values(block.input)) {
      const rel = typeof v === 'string' ? relOf(v) : null;
      if (rel && !byRel.has(rel)) byRel.set(rel, { ref_dir: '~/leak', rel_path: rel, ref_kind: 'quick', tool_name: toolName, n: 1 });
    }
  }
  return { refs: [...byRel.values()], counts: {} };
}
