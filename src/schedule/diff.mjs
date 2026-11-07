// Pure line diff for the dry-run output (plan 01-09). An LCS table over lines: the inputs are about 15 lines, so more
// than MAX_LINES throws a RangeError and a wrong file cannot hang the command. Built-ins only.
const MAX_LINES = 400;
const NO_NEWLINE = ' [no newline at end]';

// A line keeps a marker when the text does not end with a newline, so "b" and "b\n" differ.
function linesOf(textValue) {
  if (textValue === '') return [];
  const parts = textValue.split('\n');
  const endsWithNewline = parts[parts.length - 1] === '';
  if (endsWithNewline) parts.pop();
  if (parts.length > MAX_LINES) throw new RangeError('diff input is too long');
  return parts.map((p, i) => (i === parts.length - 1 && !endsWithNewline ? `${p}${NO_NEWLINE}` : p));
}

// oldText null means the file is new. -> [{ op: '+' | '-' | ' ', text }]
export function diffLines(oldText, newText) {
  const a = oldText === null ? [] : linesOf(oldText);
  const b = linesOf(newText);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i += 1; j += 1; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ op: '-', text: a[i] }); i += 1; }
    else { out.push({ op: '+', text: b[j] }); j += 1; }
  }
  while (i < a.length) { out.push({ op: '-', text: a[i] }); i += 1; }
  while (j < b.length) { out.push({ op: '+', text: b[j] }); j += 1; }
  return out;
}
