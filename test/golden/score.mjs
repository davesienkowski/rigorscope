// The golden scorer (plan 02-03, TRUST-10, D-20): joins golden label rows with rows of the collector snapshot
// (test/golden/inputs/inputs.jsonl, schema rigorscope.golden-inputs/1) and scores the shipped pure rules per
// dimension. Shared by the training test and the one acceptance test; it reads no label file itself.
//
// Join: a label row's (unit.repo, unit.kind through goldenKind, unit.native_id) against the input row's (repo, kind,
// native_id); units with one native_id in two repos stay distinct. A missing or not-located input is a miss in every
// dimension.
//   tier_value   denominator: every label whose tier value is not `unknown`; a hit when the predicted tier (`none`
//                for NULL) equals the label's value
//   tier_timing  denominator: labels with a letter and a declared source (not `unknown`); a hit when the predicted
//                tier_timing equals the label's source
//   risk         with a risk table: denominator every label. The predicted tags come from riskOf over touchedPaths
//                of the row; the golden tags are mapped through GOLDEN_TAG_MAP (deduplicated: two golden tags mapping
//                to one D-05 tag count once; a tag mapping to null is counted in unmapped_gold_tags, never scored). exact
//                is a hit when the two sets are equal; Jaccard is 1 for two empty sets, 0 for an unknown prediction
//                (risk_class NULL, counted in risk_unknown; a missing row counts the same), else |both| / |either|.
//                Per tag over RISK_TAGS: tp, fp, fn, with an unknown prediction read as no tag (golden tags count fn).
//                A golden tag missing from GOLDEN_TAG_MAP throws, with no tag name in the message.
// A ratio whose denominator is 0 prints `?`, never 0/0, 0 or 100%.
import { readFileSync } from 'node:fs';
import { RISK_TAGS, riskOf, touchedPaths } from '../../src/units/risk.mjs';
import { unitTier } from '../../src/units/tier.mjs';

// Every tag of test/golden/README.md "Fields and allowed values" -> its D-05 tag, or null when D-05 has none. The same
// table is in test/golden/README.md "Scoring (rigorscope)"; a golden test checks the two agree.
export const GOLDEN_TAG_MAP = Object.freeze(Object.assign(Object.create(null), {
  'gate-or-hook': 'gate-or-hook',
  'global-config': 'global-config',
  parser: 'parser',
  script: 'script',
  docs: 'docs',
  security: 'security',
  push: 'security',
  credentials: 'security',
  datastore: null,
  validation: null,
  'business-logic': null,
}));

const LETTERS = new Set(['A', 'B', 'C']);

// Golden kind -> snapshot kind.
export function goldenKind(kind) {
  if (kind === 'quick') return 'quick';
  if (kind === 'phase-plan') return 'plan';
  return null;
}

export const unitKeyOf = ({ repo, kind, native_id: nativeId }) => `${repo}:${kind}:${nativeId}`;

// -> the parsed rows of a JSONL file; blank lines are skipped, a bad line throws with its line number only.
export function readJsonl(file) {
  const rows = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '');
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`bad JSON at line ${i + 1}`);
    }
  }
  return rows;
}

// -> the predicted attributes of one located input row (risk only with a table), or null for a missing row.
export function predict(row, { riskTable } = {}) {
  if (!row || row.located !== true) return null;
  const tier = unitTier({ artifacts: row.artifacts, commits: row.commits });
  if (!riskTable) return tier;
  return { ...tier, ...riskOf(touchedPaths({ filesModified: row.files_modified, commits: row.commits }), riskTable) };
}

// -> { tags: sorted unique D-05 tags, unmapped: number of golden tags with no D-05 tag }.
function goldenTags(label) {
  const tags = new Set();
  const unmapped = new Set();
  for (const r of Array.isArray(label.risk_class) ? label.risk_class : []) {
    if (typeof r?.tag !== 'string' || !Object.hasOwn(GOLDEN_TAG_MAP, r.tag)) throw new Error('a golden risk tag is not in GOLDEN_TAG_MAP');
    const mapped = GOLDEN_TAG_MAP[r.tag];
    if (mapped === null) unmapped.add(r.tag);
    else tags.add(mapped);
  }
  return { tags, unmapped: unmapped.size };
}

function newRisk(table) {
  const perTag = {};
  for (const t of RISK_TAGS) perTag[t] = { tp: 0, fp: 0, fn: 0 };
  return {
    version: table.version, exact: { hit: 0, n: 0 }, jaccardSum: 0, jaccardMean: null, unknown: 0, unmapped: 0, perTag,
  };
}

function scoreRisk(risk, label, pred) {
  const gold = goldenTags(label);
  risk.unmapped += gold.unmapped;
  risk.exact.n += 1;
  const known = pred !== null && Array.isArray(pred.risk_class);
  const got = new Set(known ? pred.risk_class : []);
  if (!known) risk.unknown += 1;
  for (const t of RISK_TAGS) {
    if (got.has(t) && gold.tags.has(t)) risk.perTag[t].tp += 1;
    else if (got.has(t)) risk.perTag[t].fp += 1;
    else if (gold.tags.has(t)) risk.perTag[t].fn += 1;
  }
  if (!known) return;
  const both = [...got].filter((t) => gold.tags.has(t)).length;
  const either = new Set([...got, ...gold.tags]).size;
  risk.jaccardSum += either === 0 ? 1 : both / either;
  if (both === got.size && both === gold.tags.size) risk.exact.hit += 1;
}

const ratio = () => ({ hit: 0, n: 0 });

export function scoreGolden({ labels, inputs, riskTable }) {
  const byKey = new Map();
  for (const r of inputs ?? []) byKey.set(unitKeyOf(r), r);
  const score = {
    units: 0, located: 0, tierValue: { ...ratio(), misses: [] }, tierTiming: ratio(), risk: riskTable ? newRisk(riskTable) : null,
  };
  for (const l of labels ?? []) {
    const key = unitKeyOf({ repo: l.unit.repo, kind: goldenKind(l.unit.kind), native_id: l.unit.native_id });
    const row = byKey.get(key);
    const pred = predict(row, { riskTable });
    score.units += 1;
    if (pred !== null) score.located += 1;
    const gold = l.tier?.value;
    if (gold !== 'unknown') {
      score.tierValue.n += 1;
      if (pred !== null && (pred.tier ?? 'none') === gold) score.tierValue.hit += 1;
      else score.tierValue.misses.push(key);
    }
    if (LETTERS.has(gold) && typeof l.tier?.source === 'string' && l.tier.source !== 'unknown') {
      score.tierTiming.n += 1;
      if (pred !== null && pred.tier_timing === l.tier.source) score.tierTiming.hit += 1;
    }
    if (score.risk) scoreRisk(score.risk, l, pred);
  }
  if (score.risk && score.risk.exact.n > 0) score.risk.jaccardMean = score.risk.jaccardSum / score.risk.exact.n;
  return score;
}

const fraction = ({ hit, n }) => (n === 0 ? '?' : `${hit}/${n}`);

export function formatScore(name, score) {
  const head = `golden ${name}: units=${score.units} located=${score.located} tier_value=${fraction(score.tierValue)} tier_timing=${fraction(score.tierTiming)}`;
  const r = score.risk;
  if (!r) return head;
  const jaccard = r.jaccardMean === null ? '?' : r.jaccardMean.toFixed(3);
  return `${head} risk_exact=${fraction(r.exact)} risk_jaccard=${jaccard} risk_unknown=${r.unknown} unmapped_gold_tags=${r.unmapped} rules=${r.version}`;
}

// -> `golden <name> risk tags: <tag> tp=N fp=N fn=N; ...` in bytewise tag order (training only; never ids or labels).
export function formatTagLine(name, score) {
  const tags = Object.keys(score.risk?.perTag ?? {}).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return `golden ${name} risk tags: ${tags.map((t) => {
    const c = score.risk.perTag[t];
    return `${t} tp=${c.tp} fp=${c.fp} fn=${c.fn}`;
  }).join('; ')}`;
}
