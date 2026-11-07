// Prohibition (plan 02-04, UNIT-06, D-12 with amendment Q4, D-14, ADR-0002, T-02-30, T-02-31): MUST NOT capture tool
// input text or a slash-command argument. Only a shape-checked planning path from the file_path, path, notebook_path or
// pattern field of a tool_use block becomes a ref, and only the command name becomes a command row; Bash command
// strings, file content, edit strings, free-text patterns and command arguments never leave the extractor.
//
// Subject-injectable: GSD_PROHIB_SUBJECT names a module exporting normalizeRefs and normalizeCommandLine, resolved
// against process.cwd(); unset means src/sources/transcript/refs.mjs.
// test/prohibitions/fixtures/no-tool-input-stored-violation.mjs (it also turns every string input value holding a
// `.planning/quick/` path into a ref and appends the command arguments to the name) must fail this test;
// test/prohibitions/fixtures/no-tool-input-stored-clean.mjs (re-exports the real functions) must pass it.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildHomeSet } from '../../src/sources/transcript/home.mjs';

const DEFAULT_SUBJECT = fileURLToPath(new URL('../../src/sources/transcript/refs.mjs', import.meta.url));
const subject = process.env.GSD_PROHIB_SUBJECT ? resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT) : DEFAULT_SUBJECT;

const HOME = '/h/u';
const ctx = { homeSet: buildHomeSet({ home: HOME }), cwd: '~/work/p' };
const planning = (slug) => `${HOME}/repos/p/.planning/quick/${slug}/${slug.slice(0, 10)}-PLAN.md`;
const SLUGS = ['261031-pbx-bashonly', '261031-pcx-contentonly', '261031-pex-editonly', '261031-pgx-greponly'];
const tool = (name, input) => ({ type: 'tool_use', id: `toolu_${name}`, name, input });

it('A: only the structured path field of a tool_use block becomes a ref; command, content, edit and free-text strings never do', async () => {
  const { normalizeRefs } = await import(pathToFileURL(subject).href);
  const line = {
    type: 'assistant',
    message: {
      id: 'm',
      content: [
        tool('Bash', { command: `cat ${planning(SLUGS[0])}`, description: `Show ${planning(SLUGS[0])}` }),
        tool('Write', { file_path: planning('261031-pwf-writefile'), content: `notes about ${planning(SLUGS[1])}` }),
        tool('Edit', { file_path: `${HOME}/repos/p/README.md`, old_string: planning(SLUGS[2]), new_string: `x ${planning(SLUGS[2])}` }),
        tool('Grep', { pattern: `free text ${planning(SLUGS[3])}` }),
      ],
    },
  };
  const out = JSON.stringify(normalizeRefs(line, ctx));
  assert.ok(out.includes('.planning/quick/261031-pwf-writefile'), 'the Write file_path ref is kept');
  for (const slug of SLUGS) assert.ok(!out.includes(slug), `a tool input text slug was captured (${SLUGS.indexOf(slug)})`);
});

it('B: a command row holds the command name and never its arguments', async () => {
  const { normalizeCommandLine } = await import(pathToFileURL(subject).href);
  const line = {
    type: 'user', sessionId: 'sess-prohib', uuid: 'uuid-prohib', timestamp: '2026-10-27T16:00:00.000Z',
    message: { role: 'user', content: '<command-name>/gsd-quick</command-name>\n<command-args>PROHIB-args-text</command-args>' },
  };
  const out = JSON.stringify(normalizeCommandLine(line, {}));
  assert.ok(out.includes('gsd-quick'), 'the command name is kept');
  assert.ok(!out.includes('PROHIB-args-text'), 'the command arguments were captured');
});
