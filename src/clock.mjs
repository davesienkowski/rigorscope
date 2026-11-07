// The clock seam (plan 01-08, D-07). RIGORSCOPE_NOW, a UTC instant in the strict ISO form
// YYYY-MM-DDTHH:MM:SS[.mmm]Z, fixes the clock for the default 7-day window and the freshness ages; every report then
// says `(clock fixed by RIGORSCOPE_NOW)`. An invalid value is an error, never ignored: a silently ignored clock
// override would be a fail-open. Pure: no state, no sqlite.
export const NOW_ENV = 'RIGORSCOPE_NOW';

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const MESSAGE = 'RIGORSCOPE_NOW must be a UTC instant such as 2026-11-03T12:00:00Z or 2026-11-03T12:00:00.000Z';

// -> { now: () => Date, fixed }. Throws RangeError(MESSAGE) for a value that is not a real instant.
export function clockFromEnv(env) {
  const value = env?.[NOW_ENV];
  if (value === undefined) return { now: () => new Date(), fixed: false };
  const m = typeof value === 'string' ? INSTANT.exec(value) : null;
  if (!m) throw new RangeError(MESSAGE);
  const ms = Date.parse(value);
  // Date.parse accepts a day such as 02-30; the round trip does not.
  const canonical = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7] ?? '000'}Z`;
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== canonical) throw new RangeError(MESSAGE);
  return { now: () => new Date(ms), fixed: true };
}
