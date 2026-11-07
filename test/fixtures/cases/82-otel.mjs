// Case 82: the OTel receiver directories (plan 01-03). The live directory holds twenty events lines, nine
// metrics lines and a partial tail; the preserve directory holds a byte prefix of the live events file,
// a preserve-only day and a byte-identical copy of the live metrics file. Expectations are hand-computed
// in test/fixtures/otel.mjs (OTEL_EXPECTED, both directories ingested in one run). Never imports build.mjs.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OTEL_EXPECTED, buildOtelTree } from '../otel.mjs';

export const id = 'otel';
export const group = 'extra';
export const sources = ['otel'];

export function build(ctx) {
  return buildOtelTree(ctx.home, { preserve: true });
}

export const expected = {
  messageKeys: {},
  sourceFiles: OTEL_EXPECTED.sourceFiles,
  agentMeta: [],
  skipped: {},
  unknownAttr: OTEL_EXPECTED.unknownAttr.both,
  dropped: OTEL_EXPECTED.dropped.both,
  rejected: OTEL_EXPECTED.rejected.both,
  unknownToken: OTEL_EXPECTED.unknownToken.both,
};

export function verify(ctx) {
  const db = new DatabaseSync(join(ctx.home, '.rigorscope', 'store.db'), { readOnly: true });
  try {
    const n = (t) => db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
    if (n('otel_event') !== OTEL_EXPECTED.both.events) throw new Error(`otel_event rows ${n('otel_event')}`);
    if (n('otel_metric') !== OTEL_EXPECTED.both.metrics) throw new Error(`otel_metric rows ${n('otel_metric')}`);
  } finally {
    db.close();
  }
}
