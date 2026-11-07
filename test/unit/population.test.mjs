// Plan 03-04 (D-15): the --population selector. A leaf module: one fixed message that never echoes the value.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  POPULATIONS, POPULATION_MESSAGE, parsePopulation, selectedPopulations,
} from '../../src/report/population.mjs';

describe('population selector', () => {
  it('POPULATIONS lists forward then reconstructed and nothing else', () => {
    assert.deepEqual([...POPULATIONS], ['forward', 'reconstructed']);
  });
  it('parsePopulation: undefined is all; forward, reconstructed and all are accepted exactly', () => {
    assert.equal(parsePopulation(undefined), 'all');
    for (const v of ['forward', 'reconstructed', 'all']) assert.equal(parsePopulation(v), v);
  });
  it('parsePopulation: any other value throws the one fixed message without echoing the value', () => {
    for (const bad of ['ALL', 'Forward', 'forward,reconstructed', '', ' forward', 'mixed', 'SECRET-VALUE-77']) {
      assert.throws(() => parsePopulation(bad), (err) => err instanceof RangeError && err.message === POPULATION_MESSAGE
        && !err.message.includes('SECRET'));
    }
    assert.throws(() => parsePopulation(5), RangeError);
  });
  it('selectedPopulations: all gives forward then reconstructed, a single value gives that one', () => {
    assert.deepEqual(selectedPopulations('all'), ['forward', 'reconstructed']);
    assert.deepEqual(selectedPopulations('forward'), ['forward']);
    assert.deepEqual(selectedPopulations('reconstructed'), ['reconstructed']);
  });
});
