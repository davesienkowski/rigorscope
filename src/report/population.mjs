// The --population selector of `units`, `tier` and `cost` (plan 03-04, TRUST-03, D-15). A leaf module: no imports. The two
// populations are never one figure; `all` shows them side by side, forward first. A bad value is one fixed message that never
// echoes the value (a usage error before any state is touched).
export const POPULATIONS = Object.freeze(['forward', 'reconstructed']);
const SELECTIONS = Object.freeze([...POPULATIONS, 'all']);
export const POPULATION_MESSAGE = 'the --population value must be exactly one of forward, reconstructed or all, given once';

// undefined -> 'all'. Anything but the three exact words throws a RangeError (the commands turn it into a usage error).
export function parsePopulation(text) {
  if (text === undefined) return 'all';
  if (typeof text !== 'string' || !SELECTIONS.includes(text)) throw new RangeError(POPULATION_MESSAGE);
  return text;
}

// parseArgs keeps every occurrence of a `multiple` option: more than one is the same usage error. -> the selection.
export function populationFromArgs(values) {
  if (values === undefined) return parsePopulation(undefined);
  if (!Array.isArray(values) || values.length !== 1) throw new RangeError(POPULATION_MESSAGE);
  return parsePopulation(values[0]);
}

// 'all' -> ['forward', 'reconstructed'] (forward first); a single value -> that one.
export const selectedPopulations = (selection) => (selection === 'all' ? [...POPULATIONS] : [selection]);
