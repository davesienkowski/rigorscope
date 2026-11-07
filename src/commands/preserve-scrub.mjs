// rigorscope preserve-scrub [--apply] [--full]
//
// Removes tool_parameters, tool_input and error (D-05) from rigorscope's own preserve copy of the OTel
// files. A dry run by default: it writes nothing, takes no lock and says what --apply would do. --full widens
// the rule set to prompt, prompt_text, response, vcs.ref.head.name, terminal.type and the identity keys. This
// is the one command that writes outside the state directory, and only inside the preserve directory; it never
// opens the store. --apply takes the ingest lock first (plan 01-12, U2), so it never rewrites a file that an
// ingest is reading; taking the lock creates the 0700 state directory like ingest does. When an ingest holds the
// lock it prints a skip line, rewrites nothing and exits 0. The live receiver directory is not reachable from
// here. Output names files, counts and fixed rule names only, never a value.
import { preserveDir } from '../sources/otel/dirs.mjs';
import { ScrubDirError, scrubPreserveDir } from '../redact/scrub-preserve.mjs';
import { withLock } from '../ingest/lock.mjs';

export const description = 'Remove tool_parameters, tool_input and error from the preserve copy of the OTel files (dry run unless --apply)';
export const options = { apply: { type: 'boolean' }, full: { type: 'boolean' } };

const pairs = (obj) => {
  const entries = Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? 'none' : entries.map(([k, n]) => `${k}:${n}`).join(',');
};

export async function run(args, ctx) {
  const apply = args.apply === true;
  const scrub = () => scrubPreserveDir({ dir: preserveDir(ctx.home), apply, full: args.full === true });
  let res;
  try {
    if (apply) {
      const locked = await withLock({ home: ctx.home, now: ctx.now }, scrub);
      if (!locked.acquired) {
        const h = locked.holder ?? {};
        ctx.stdout.write(`preserve-scrub: skipped, an ingest holds the lock (pid ${h.pid ?? 'unknown'} since ${h.started_utc ?? 'unknown'})\n`);
        return 0;
      }
      res = locked.value;
    } else {
      res = scrub();
    }
  } catch (err) {
    if (err instanceof ScrubDirError) {
      if (err.code === 'absent') {
        ctx.stdout.write('preserve-scrub: no preserve directory\n');
        return 0;
      }
      ctx.stderr.write(`rigorscope: preserve-scrub: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  const out = [];
  for (const f of res.files) {
    out.push(`preserve-scrub: ${f.name} lines=${f.lines} rewritten=${f.rewritten} dropped=${f.dropped} unparseable_kept=${f.unparseableKept} removed=${pairs(f.removed)}`);
  }
  const t = res.totals;
  out.push(
    `preserve-scrub: files=${t.files} rewritten=${t.changedFiles} unchanged=${t.unchangedFiles} skipped=${pairs(res.skipped)} ` +
      `mode=${apply ? 'apply' : 'dry-run'} rules=${res.rules}`,
  );
  if (!apply) {
    out.push(`preserve-scrub: dry run, nothing was written; re-run with --apply to rewrite ${t.changedFiles} file(s)`);
  }
  ctx.stdout.write(`${out.join('\n')}\n`);
  return 0;
}
