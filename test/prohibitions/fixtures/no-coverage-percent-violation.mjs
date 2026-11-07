// The violation subject of test/prohibitions/no-coverage-percent.test.mjs (plan 03.1-04): a mutated renderer that plants a
// percent sign in the roster and unclassified lines of the doctor text and a coverage word in the classes ingest line, so the
// prohibition is proven able to fail.
export const transform = (label, text) => text
  .split('\n')
  .map((l) => {
    if (label === 'doctor' && (l.startsWith('roster: ') || l.startsWith('unclassified: '))) return `${l} (12%)`;
    if (label === 'ingest' && l.startsWith('classes: ')) return `${l} coverage=9`;
    return l;
  })
  .join('\n');
