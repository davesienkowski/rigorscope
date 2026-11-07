// Runtime preflight (DATA-01, D-02). Pure: this module must never import the built-in sqlite module,
// because it has to run (and fail cleanly) on a Node that lacks it. bin/rigorscope.mjs runs it first.
import { isBuiltin } from 'node:module';

export const NODE_FLOOR = Object.freeze({ major: 24, minor: 15 });

const FIX = 'nvm install 24 && nvm alias default 24';

// checkRuntime never throws: anything that is not a plain "major.minor.patch" string is unusable.
export function checkRuntime({ node, hasSqlite } = {}) {
  const m = typeof node === 'string' ? /^(\d+)\.(\d+)\.(\d+)/.exec(node) : null;
  if (!m) {
    return {
      ok: false,
      exit: 2,
      msg: `rigorscope needs Node >= ${NODE_FLOOR.major}.${NODE_FLOOR.minor}.0 (found an unreadable version); run: ${FIX}`,
    };
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < NODE_FLOOR.major || (major === NODE_FLOOR.major && minor < NODE_FLOOR.minor)) {
    return {
      ok: false,
      exit: 2,
      msg: `rigorscope needs Node >= ${NODE_FLOOR.major}.${NODE_FLOOR.minor}.0 (found ${m[1]}.${m[2]}.${m[3]}); run: ${FIX}`,
    };
  }
  if (hasSqlite !== true) {
    return {
      ok: false,
      exit: 2,
      msg: 'rigorscope needs the built-in node:sqlite module, which this Node build lacks; use an official Node 24.15 or newer binary',
    };
  }
  return { ok: true };
}

export function runPreflight() {
  return checkRuntime({ node: process.versions.node, hasSqlite: isBuiltin('node:sqlite') });
}
