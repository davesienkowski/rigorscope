// Plant module for the environment snapshot (plan 02-04, DATA-07, D-16 with amendment Q3, T-02-32, T-02-36). It writes
// into the canary HOME every owner-machine source the snapshotter may read, each holding values it must never keep:
//   - <root>/settings.json: hook commands holding the command plant and a hook plant, an env token, a permissions
//     entry naming a path under HOME, a statusLine command, a model that fails the shape and a valid advisor model
//   - <root>/gsd-core/VERSION holding text that fails the version shape
//   - <root>/gsd-file-manifest.json with a valid version, a planted mode and a files map keyed by a HOME path
//   - <home>/CANARY-plant-base/installed-base.json with a valid sha and planted source and evidence keys
//   - a local-mods repository at <home>/CANARY-plant-localmods (its path holds a plant)
// The env-snapshot scenario points RIGORSCOPE_INSTALLED_BASE_FILE and RIGORSCOPE_LOCAL_MODS_DIR at the last two
// (pathsOf). plant(ctx) returns every planted string as a needle.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo } from '../../fixtures/git-repo.mjs';

export const id = 'env';
export const source = 'env';

export const pathsOf = (home) => ({
  baseFile: join(home, 'CANARY-plant-base', 'installed-base.json'),
  modsDir: join(home, 'CANARY-plant-localmods'),
});

const write = (file, text) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text, 'utf8');
};

export function plant(ctx) {
  const { root, home, plants: P } = ctx;
  const extra = {
    hookCmd: 'CANARY-plant-hook-cmd',
    envToken: 'CANARY-plant-env-token',
    statusCmd: 'CANARY-plant-status-cmd',
    model: 'CANARY plant model',
    version: 'CANARY-plant-version text',
    mode: 'CANARY-plant-manifest-mode',
    baseSource: 'CANARY-plant-base-source',
    baseEvidence: 'CANARY-plant-base-evidence',
    mods: 'CANARY-plant-localmods',
  };
  write(join(root, 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: P.command }] }],
      Stop: [{ hooks: [{ type: 'command', command: `${extra.hookCmd} --flag` }] }],
    },
    env: { API_TOKEN: extra.envToken },
    permissions: { allow: [`Read(${home}/${P.osUser}/secret/**)`] },
    statusLine: { type: 'command', command: extra.statusCmd },
    model: extra.model,
    advisorModel: 'haiku',
  }));
  write(join(root, 'gsd-core', 'VERSION'), `${extra.version}\n`);
  write(join(root, 'gsd-file-manifest.json'), JSON.stringify({
    version: '9.9.9', mode: extra.mode, files: { [`${home}/${P.osUser}/file.md`]: 'x' },
  }));
  const { baseFile, modsDir } = pathsOf(home);
  write(baseFile, JSON.stringify({
    sha: 'abcabcabcabcabcabcabcabcabcabcabcabcabca', source: extra.baseSource, evidence: extra.baseEvidence,
  }));
  makeRepo(modsDir, { home, files: { 'README.md': 'local mods fixture\n' } });
  return { needles: Object.values(extra) };
}
