// KNOWN-BAD subject for test/prohibitions/overlap-not-spread.test.mjs: "spread it rather than lose it". A scope with
// several counted units is attributed to its bytewise-first unit and carries a list of equal shares, the violation the
// prohibition forbids. Everything else is the real module.
import { attributeScope as real } from '../../../src/derive/attribution.mjs';

export {
  BUCKETS, LINK_CONFIDENCE_MODES, REASONS, checkAttribution, fillAttribution,
} from '../../../src/derive/attribution.mjs';

export function attributeScope({ links, mode }) {
  const r = real({ links, mode });
  if (r.bucket !== 'unattributed_overlap' || r.countedUnits < 2) return r;
  const units = [...new Set(links.map((l) => l.unit_key))].sort();
  return {
    bucket: 'attributed',
    reason: 'one-unit',
    unitKey: units[0],
    countedUnits: units.length,
    shares: units.map((u) => ({ unitKey: u, share: 1 / units.length })),
  };
}
