// Fixed clock instants for the spawned-CLI tests (plan 01-08). A helper, not a test.
// FIXTURE_NOW keeps every pre-01-08 fixture inside the 168-hour default window (the earliest call record
// of those cases is 2026-10-26T09:00:00Z, the window starts 2026-10-21T12:00:00Z). DST_NOW follows the DST case.
export const FIXTURE_NOW = '2026-10-28T12:00:00.000Z';
export const DST_NOW = '2026-11-03T12:00:00.000Z';
