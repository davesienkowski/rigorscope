// The violation subject of the sheet prohibition tests (plan 03-05): wraps the real modules and breaks every rule on purpose, so
// test/prohibitions/no-score.test.mjs is proven able to fail. It adds a numeric `score` key to every row, a recommendation word to
// every reason, a total across the calibrate fields and reorders the rows with `can decide today` first.
import { calibrateFields as real } from '../../../src/report/calibrate.mjs';
import { ROW_IDS, ROW_KEYS, buildSheet as realSheet } from '../../../src/report/sheet.mjs';

export { ROW_IDS, ROW_KEYS };
export const calibrateFields = (rows, links) => {
  const doc = real(rows, links);
  return { ...doc, total: doc.fields.reduce((n, f) => n + f.agree, 0), accuracy: 0.5 };
};
export const buildSheet = (surface, input) => realSheet(surface, input)
  .map((r) => ({ ...r, score: 1, reason: `${r.reason}; you should recommend this` }))
  .sort((a, b) => (a.status === b.status ? 0 : (a.status === 'cannot' ? 1 : -1)));
