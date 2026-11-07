// KNOWN-BAD subject for test/prohibitions/no-score.test.mjs: "one number to rank them all". Every lead gets a numeric combined
// rank key and one lead pooled over every stratum, with a verdict word, is put first: the score, the pooled figure and the
// verdict the prohibition forbids. Everything else is the real module.
import { buildLeads as real } from '../../../src/report/leads.mjs';

export {
  LEAD_KEYS, MAX_LEADS, PAIR_ORDER, candidateLeads, leadSentence, orderLeads,
} from '../../../src/report/leads.mjs';

export function buildLeads(strata, opts) {
  const out = real(strata, opts);
  const scored = out.leads.map((l, i) => ({ ...l, rank_score: (out.leads.length - i) * 100 }));
  const pooled = {
    ...(scored[0] ?? { tiers: ['A', 'B'] }),
    stratum: 'overall',
    sentence: 'Overall verdict: tier A passes.',
    rank_score: 1000,
  };
  return { leads: [pooled, ...scored].slice(0, 5), omitted: out.omitted };
}
