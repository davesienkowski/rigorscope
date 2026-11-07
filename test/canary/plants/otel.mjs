// Plant module for the OTel source (plan 01-03). It writes the OTel fixture tree (live and preserve
// directories, identity keys and content keys on every kind that carries them, hostile names and values)
// into the canary HOME and returns every OTel plant, including the non-ASCII forms, as needles.
import { OTEL_NON_ASCII_ESCAPED, OTEL_PLANTS, buildOtelTree } from '../../fixtures/otel.mjs';

export const id = 'otel';
export const source = 'otel';

export function plant(ctx) {
  buildOtelTree(ctx.home, { preserve: true });
  return { needles: [...Object.values(OTEL_PLANTS), OTEL_NON_ASCII_ESCAPED] };
}
