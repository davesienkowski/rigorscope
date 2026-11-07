// Command dispatch. A command is a file in src/commands/ exporting `description`, `options` (a
// util.parseArgs options object) and `run(args, ctx)`. A command may also export `positionals`
// ({ min, max, names }); it then receives the positional values as args.positionals, and a command without it
// still rejects a stray positional (plan 01-08). Exit codes: 0 success, 2 usage or preflight
// error, 1 rigorscope's own failure (also a store with a pending migration, plan 02-01: every command that opens the
// store refuses it until rigorscope migrate --apply), 143 / 130 an ingest interrupted by SIGTERM / SIGINT (plan 01-11).
// Errors print one line to stderr and never a stack, a SQL text or file content (RR-03).
import { parseArgs } from 'node:util';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { StateDirError, StoreMigrationPendingError, StoreTooNewError } from './db.mjs';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const COMMANDS_DIR = fileURLToPath(new URL('./commands/', import.meta.url));
const NAME = /^[a-z][a-z-]*$/;
const INTERRUPT_SIGNALS = new Set(['SIGTERM', 'SIGINT']);

function commandNames() {
  return readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.slice(0, -4))
    .filter((n) => NAME.test(n))
    .sort();
}

async function loadCommand(name) {
  if (!NAME.test(name) || !existsSync(join(COMMANDS_DIR, `${name}.mjs`))) {
    throw new UsageError(`unknown command "${name.slice(0, 40).replace(/[^\x20-\x7e]/g, '?')}"; run rigorscope --help`);
  }
  return import(pathToFileURL(join(COMMANDS_DIR, `${name}.mjs`)).href);
}

async function usage() {
  const lines = ['usage: rigorscope <command> [options]', '', 'commands:'];
  for (const name of commandNames()) {
    const mod = await loadCommand(name);
    lines.push(`  ${name.padEnd(8)} ${mod.description}`);
  }
  lines.push('', 'Run "rigorscope <command> --help" for the options of one command.');
  return `${lines.join('\n')}\n`;
}

function commandHelp(name, mod) {
  const pos = mod.positionals ? ` ${mod.positionals.names.join(' ')}` : '';
  const lines = [`usage: rigorscope ${name}${pos} [options]`, '', mod.description];
  const opts = Object.entries(mod.options);
  if (opts.length > 0) {
    lines.push('', 'options:');
    for (const [flag, spec] of opts) lines.push(`  --${flag} <${spec.type}>`);
  }
  lines.push('  --help, -h');
  return `${lines.join('\n')}\n`;
}

export async function main(argv, ctx) {
  try {
    if (argv.length === 0) {
      ctx.stderr.write(await usage());
      return 2;
    }
    if (argv[0] === '--help' || argv[0] === '-h') {
      ctx.stdout.write(await usage());
      return 0;
    }
    const name = argv[0];
    const mod = await loadCommand(name);
    let values;
    let positionals = [];
    try {
      ({ values, positionals } = parseArgs({
        args: argv.slice(1),
        options: { ...mod.options, help: { type: 'boolean', short: 'h' } },
        strict: true,
        allowPositionals: mod.positionals !== undefined,
      }));
    } catch (err) {
      if (typeof err.code === 'string' && err.code.startsWith('ERR_PARSE_ARGS')) throw new UsageError(err.message);
      throw err;
    }
    if (values.help) {
      ctx.stdout.write(commandHelp(name, mod));
      return 0;
    }
    if (mod.positionals) {
      if (positionals.length < mod.positionals.min || positionals.length > mod.positionals.max) {
        throw new UsageError(`expected ${mod.positionals.names.join(' ')}; run rigorscope ${name} --help`);
      }
      return (await mod.run({ ...values, positionals }, ctx)) ?? 0;
    }
    return (await mod.run(values, ctx)) ?? 0;
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.stderr.write(`rigorscope: ${err.message}\n`);
      return 2;
    }
    if (err instanceof StateDirError || err instanceof StoreTooNewError || err instanceof StoreMigrationPendingError
      || err?.name === 'LockError') {
      ctx.stderr.write(`rigorscope: ${err.message}\n`);
      return 1;
    }
    if (err?.name === 'InterruptError' && INTERRUPT_SIGNALS.has(err.code)) {
      ctx.stderr.write(`rigorscope: interrupted by ${err.code}; committed chunks are kept, the next run resumes\n`);
      return err.exitCode;
    }
    ctx.stderr.write(`rigorscope: internal error (${err?.name ?? 'Error'}${err?.code ? ` ${err.code}` : ''})\n`);
    return 1;
  }
}
