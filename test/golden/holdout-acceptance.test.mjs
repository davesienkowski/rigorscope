// Held-out acceptance score (plan 02-03, TRUST-10, D-20, coordinator constraint 9). This file is the only reader of
// the held-out golden label file test/golden/holdout.jsonl (test/prohibitions/holdout-isolation.test.mjs enforces
// that): the labels stay unseen by whoever writes or tunes a parser, a rule table, the collector or the training
// scorer, so agreement here is evidence about the shipped rules, not a restatement of them.
//
// It asserts shape and isolation only (5 rows of schema_version 1 with held_out true, keys disjoint from the training
// file, a located snapshot row for each, every golden tag in GOLDEN_TAG_MAP), with failure messages that are counts
// only, and then reports the score once as one test diagnostic through formatScore: counts per dimension, never a
// unit id, a label or a prediction. It never asserts on the score. A low score is a finding for the next rule version,
// to be designed and scored on the training file, never a reason to edit the shipped rules now.
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRiskRules } from '../../src/units/risk-rules.mjs';
import {
  GOLDEN_TAG_MAP, formatScore, goldenKind, readJsonl, scoreGolden, unitKeyOf,
} from './score.mjs';

const GOLDEN = fileURLToPath(new URL('./', import.meta.url));
const HELD_OUT = join(GOLDEN, 'holdout.jsonl');
const TRAINING = join(GOLDEN, 'units.jsonl');
const INPUTS = join(GOLDEN, 'inputs', 'inputs.jsonl');
const HELD_OUT_UNITS = 5;

const keyOf = (l) => unitKeyOf({ repo: l.unit?.repo, kind: goldenKind(l.unit?.kind), native_id: l.unit?.native_id });

it('the held-out labels have their shape, stay disjoint from training, have located inputs; the score is reported once', (t) => {
  const held = readJsonl(HELD_OUT);
  const training = readJsonl(TRAINING);
  const inputs = readJsonl(INPUTS);
  assert.equal(held.length, HELD_OUT_UNITS, 'held-out row count');
  assert.equal(held.filter((l) => l.schema_version !== 1).length, 0, 'rows with a schema_version other than 1');
  assert.equal(held.filter((l) => l.held_out !== true).length, 0, 'rows without held_out true');
  const trainingKeys = new Set(training.map(keyOf));
  assert.equal(held.filter((l) => trainingKeys.has(keyOf(l))).length, 0, 'rows that are also training rows');
  const located = new Set(inputs.filter((r) => r.located === true).map(unitKeyOf));
  assert.equal(held.filter((l) => !located.has(keyOf(l))).length, 0, 'rows with no located snapshot row');
  const tags = held.flatMap((l) => (Array.isArray(l.risk_class) ? l.risk_class : []).map((r) => r?.tag));
  assert.equal(tags.filter((tag) => typeof tag !== 'string' || !Object.hasOwn(GOLDEN_TAG_MAP, tag)).length, 0, 'tags missing from GOLDEN_TAG_MAP');
  t.diagnostic(formatScore('holdout', scoreGolden({ labels: held, inputs, riskTable: loadRiskRules() })));
});

// Same synthetic-id rule as golden-ids.test.mjs, applied here because this file is the only reader of the label file.
// Counts only in the message, never a value.
it('the held-out label file holds no 12-hex token other than the synthetic zeros-digits-zeros form', () => {
  const tokens = readFileSync(HELD_OUT, 'utf8').match(/(?<![0-9a-f])[0-9a-f]{12}(?![0-9a-f])/g) ?? [];
  assert.equal(tokens.filter((x) => !/^0000[0-9]{4}0000$/.test(x)).length, 0, 'non-synthetic 12-hex tokens');
});
