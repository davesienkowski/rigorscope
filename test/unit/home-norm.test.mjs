// Home-prefix normalization (RR-03, T-01-10). Written before src/sources/transcript/home.mjs. The
// custom home below is built from parts so no literal absolute home path appears in this file.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const load = () => import(new URL('../../src/sources/transcript/home.mjs', import.meta.url).href);
const HOME = ['', 'srv', 'users', 'CANARYuser'].join('/');
const WINDIR = ['', 'fixture', 'winusers'].join('/');
const USER = 'CANARYwin';
const windowsUsers = [{ alias: 'win', user: USER, usersDir: WINDIR }];

async function set() {
  const { buildHomeSet } = await load();
  return buildHomeSet({ home: HOME, windowsUsers });
}

describe('mangle', () => {
  it('replaces every non-alphanumeric character with a dash', async () => {
    const { mangle } = await load();
    assert.equal(mangle('/a b#c.d_e'), '-a-b-c-d-e');
    assert.equal(mangle('abcXYZ019'), 'abcXYZ019');
  });
});

describe('normalizeCwd', () => {
  it('maps the WSL home and its subpaths to ~', async () => {
    const { normalizeCwd } = await load();
    const hs = await set();
    assert.equal(normalizeCwd(HOME, hs), '~');
    assert.equal(normalizeCwd(`${HOME}/repos/app`, hs), '~/repos/app');
  });

  it('matches only at a path boundary: a longer sibling name is left alone', async () => {
    const { normalizeCwd } = await load();
    const hs = await set();
    assert.equal(normalizeCwd(`${HOME}longer/x`, hs), `${HOME}longer/x`);
  });

  it('maps Windows drive-letter forms of a known user to ~win with forward slashes', async () => {
    const { normalizeCwd } = await load();
    const hs = await set();
    assert.equal(normalizeCwd(['C:', 'Users', USER, 'code', 'w'].join('\\'), hs), '~win/code/w');
    assert.equal(normalizeCwd(['c:', 'users', USER.toLowerCase(), 'x'].join('/'), hs), '~win/x');
  });

  it('maps the WSL mount form and the discovered users-directory form of a known user to ~win', async () => {
    const { normalizeCwd } = await load();
    const hs = await set();
    assert.equal(normalizeCwd(['', 'mnt', 'c', 'Users', USER, 'q'].join('/'), hs), '~win/q');
    assert.equal(normalizeCwd(`${WINDIR}/${USER}/z`, hs), '~win/z');
  });

  it('maps any other user home, in every platform form, to ~other', async () => {
    const { normalizeCwd } = await load();
    const hs = await set();
    assert.equal(normalizeCwd(['', 'home', 'intruder', 'z'].join('/'), hs), '~other/z');
    assert.equal(normalizeCwd('/Users/someone/x', hs), '~other/x');
    assert.equal(normalizeCwd('/mnt/d/Users/someone/x', hs), '~other/x');
    assert.equal(normalizeCwd('D:\\Users\\someone\\x', hs), '~other/x');
    assert.equal(normalizeCwd(['', 'home', 'solo'].join('/'), hs), '~other');
  });

  it('leaves a path outside every home unchanged', async () => {
    const { normalizeCwd } = await load();
    const hs = await set();
    assert.equal(normalizeCwd('/opt/app/run', hs), '/opt/app/run');
  });

  it('stores non-ASCII text as given', async () => {
    const { normalizeCwd } = await load();
    const hs = await set();
    assert.equal(normalizeCwd(`${HOME}/repos/caf\u00e9`, hs), '~/repos/caf\u00e9');
  });

  it('returns NULL for a non-string, a control character, and a value above 1024 characters', async () => {
    const { normalizeCwd } = await load();
    const hs = await set();
    for (const bad of [undefined, null, 42, {}, ['x'], 'a\u0007b', 'a\nb', 'x'.repeat(1025)]) {
      assert.equal(normalizeCwd(bad, hs), null, String(bad).slice(0, 10));
    }
    assert.equal(normalizeCwd('/'.concat('x'.repeat(1023)), hs).length, 1024);
  });

  it('prefers the longest known prefix when homes nest', async () => {
    const { buildHomeSet, normalizeCwd } = await load();
    const hs = buildHomeSet({ home: HOME, windowsUsers: [{ alias: 'win', user: 'x', usersDir: `${HOME}/win` }] });
    assert.equal(normalizeCwd(`${HOME}/win/x/p`, hs), '~win/p');
  });

  it('works without a home set argument (generic other-user rules still apply)', async () => {
    const { normalizeCwd } = await load();
    assert.equal(normalizeCwd('/Users/someone/x'), '~other/x');
  });
});

describe('normalizeProjectSegment', () => {
  it('replaces a leading mangled known home followed by a dash or the end with ~', async () => {
    const { normalizeProjectSegment, mangle } = await load();
    const hs = await set();
    assert.equal(normalizeProjectSegment(`${mangle(HOME)}-repos-app`, hs), '~-repos-app');
    assert.equal(normalizeProjectSegment(mangle(HOME), hs), '~');
  });

  it('never replaces when the home is only a prefix of a longer name', async () => {
    const { normalizeProjectSegment, mangle } = await load();
    const hs = await set();
    const longer = `${mangle(HOME)}longer-x`;
    assert.equal(normalizeProjectSegment(longer, hs), longer);
  });

  it('maps the mangled Windows forms of a known user to ~win', async () => {
    const { normalizeProjectSegment, mangle } = await load();
    const hs = await set();
    assert.equal(normalizeProjectSegment(`C--Users-${USER}-code-w`, hs), '~win-code-w');
    assert.equal(normalizeProjectSegment(`-mnt-c-Users-${USER}-q`, hs), '~win-q');
    assert.equal(normalizeProjectSegment(`${mangle(WINDIR)}-${USER}-z`, hs), '~win-z');
  });

  it('stores another user\'s mangled home verbatim (documented residual)', async () => {
    const { normalizeProjectSegment } = await load();
    const hs = await set();
    assert.equal(normalizeProjectSegment('-home-intruder-z', hs), '-home-intruder-z');
  });
});

describe('safeName and safeVersion', () => {
  it('safeName keeps letters, digits, dot, underscore, colon and dash up to 48 characters, else the question-mark bucket', async () => {
    const { safeName } = await load();
    assert.equal(safeName('brandNewField'), 'brandNewField');
    assert.equal(safeName('a.b_c:d-e'), 'a.b_c:d-e');
    assert.equal(safeName('x'.repeat(48)), 'x'.repeat(48));
    for (const bad of ['x'.repeat(49), '', 'has space', 'mail@example.invalid', 'tab\there', null, 7, undefined]) {
      assert.equal(safeName(bad), '?', String(bad).slice(0, 12));
    }
  });

  it('safeVersion keeps dotted numerics with an optional short suffix, else the bucket', async () => {
    const { safeVersion } = await load();
    assert.equal(safeVersion('2.9.9'), '2.9.9');
    assert.equal(safeVersion('2.1.309'), '2.1.309');
    assert.equal(safeVersion('2.1.0-beta.1'), '2.1.0-beta.1');
    for (const bad of ['v2', '2.x', 'latest', '1.2.3.4.5', 'a b', null, 3]) assert.equal(safeVersion(bad), '?', String(bad));
  });
});
