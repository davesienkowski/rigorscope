// The generated negative cases of test/prohibitions/no-coverage-percent.test.mjs (plan 03.1-04 fix round, WR-03): every form of
// a coverage ratio that is not a percent sign and not one of the original six words. FORMS drives two things from one table:
// the scanner self-test (each form planted in a sample line or JSON fragment must be flagged) and a subject for the child run
// of no-coverage-percent-fixture-fails.test.mjs (GSD_PROHIB_FORM=<id> plants the form in the real command output, and the
// prohibition must then fail). A text form appends `suffix` to the scanned lines that start with `prefix` in the output of
// `label`; a json form sets `key` to `value` in the named top-level fragment of the `doctor-json` output.
export const FORMS = Object.freeze([
  {
    id: 'pct-pair', kind: 'text', label: 'doctor', prefix: 'unclassified: ', sample: 'unclassified: files=4', suffix: ' of=10 pct=40',
  },
  {
    id: 'frac-decimal', kind: 'text', label: 'ingest', prefix: 'classes: ', sample: 'classes: repos=1', suffix: ' frac=0.4',
  },
  {
    id: 'known-slash', kind: 'text', label: 'doctor', prefix: 'roster: ', sample: 'roster: ref=abc', suffix: ' known=6/10',
  },
  {
    id: 'per-cent', kind: 'text', label: 'doctor', prefix: 'unclassified: ', sample: 'unclassified: files=4', suffix: ' (40 per cent)',
  },
  {
    id: 'bare-decimal', kind: 'text', label: 'doctor', prefix: 'roster: ', sample: 'roster: ref=abc', suffix: ' known=0.6',
  },
  {
    id: 'json-pct', kind: 'json', fragment: 'unclassified', key: 'pct', value: 40,
  },
  {
    id: 'json-percent', kind: 'json', fragment: 'unclassified', key: 'percent', value: 40,
  },
  {
    id: 'json-ratio', kind: 'json', fragment: 'roster', key: 'ratio', value: 3,
  },
  {
    id: 'json-frac', kind: 'json', fragment: 'roster', key: 'frac', value: 1,
  },
  {
    id: 'json-decimal-value', kind: 'json', fragment: 'unclassified', key: 'known', value: 0.4,
  },
  {
    id: 'json-slash-string', kind: 'json', fragment: 'unclassified', key: 'known', value: '6/10',
  },
]);

const form = FORMS.find((f) => f.id === process.env.GSD_PROHIB_FORM);

export const transform = (label, text) => {
  if (form === undefined) throw new Error('GSD_PROHIB_FORM names no form');
  if (form.kind === 'text') {
    if (label !== form.label) return text;
    return text.split('\n').map((l) => (l.startsWith(form.prefix) ? `${l}${form.suffix}` : l)).join('\n');
  }
  if (label !== 'doctor-json') return text;
  const doc = JSON.parse(text);
  doc[form.fragment][form.key] = form.value;
  return JSON.stringify(doc);
};
