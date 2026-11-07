// Plan 01-12 Task 4 (WR-03, U5, COST-04, COST-05): cc_message.has_server_tool_use is a tri-state read from the
// members of message.usage.server_tool_use (column name unchanged):
//   1     any readable member is a positive safe integer
//   0     the key is absent, or the value is an object with at least one member and EVERY member is a readable 0
//   NULL  anything else: the key is present but not an object, an empty object, or at least one unreadable member
//         and no readable member above 0 (review CR-01: an unreadable member may be a real count above 0)
// A readable member is a non-negative safe integer; a fractional, negative, string, boolean, null, nested-object or
// unsafe value is unreadable, so a value that cannot be a count never yields 1. NULL means unknown, never 0.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWLIST, normalizeAssistantLine } from '../../src/sources/transcript/normalize.mjs';
import { openStore } from '../../src/db.mjs';
import { makeAssistant, makeHome, makeUsage } from '../fixtures/build.mjs';

// One assistant line; `stu` is the server_tool_use value, or ABSENT for no key at all.
const ABSENT = Symbol('absent');
function flagOf(stu) {
  const use = makeUsage({ input: 1, output: 1, read: 0, creation: 0 });
  if (stu !== ABSENT) use.server_tool_use = stu;
  const line = makeAssistant({ session: 'sess-stu', ts: '2026-10-27T12:00:00.000Z', id: 'msg_stu', model: 'claude-opus-5-5', use });
  const { row } = normalizeAssistantLine(line);
  assert.ok(row, 'the line is kept');
  return row.has_server_tool_use;
}

describe('has_server_tool_use: key absent and readable counts', () => {
  it('the key absent gives 0', () => {
    assert.equal(flagOf(ABSENT), 0);
  });
  it('every readable member 0 gives 0', () => {
    assert.equal(flagOf({ web_search_requests: 0, web_fetch_requests: 0 }), 0);
  });
  it('a member of 0 beside a member of 3 gives 1', () => {
    assert.equal(flagOf({ web_search_requests: 0, web_fetch_requests: 3 }), 1);
  });
  it('a single member above 0 gives 1, and a sum of exactly 1 gives 1', () => {
    assert.equal(flagOf({ web_search_requests: 2 }), 1);
    assert.equal(flagOf({ web_search_requests: 1 }), 1);
  });
  it('the largest safe integer is readable', () => {
    assert.equal(flagOf({ web_search_requests: Number.MAX_SAFE_INTEGER }), 1);
  });
  it('an unreadable member beside a readable 3 still gives 1', () => {
    assert.equal(flagOf({ web_search_requests: 3, note: 'x' }), 1);
    assert.equal(flagOf({ web_search_requests: 3, x: { requests: 3 }, z: null }), 1);
  });
});

// Review CR-01 (RR-04): a readable 0 says nothing about a member this parser cannot read, so it cannot make the
// whole value 0.
describe('has_server_tool_use: an unreadable member beside a readable 0 is NULL, never 0', () => {
  it('a string member beside a readable 0 gives NULL', () => {
    assert.equal(flagOf({ web_search_requests: 0, web_fetch_requests: '3' }), null);
    assert.equal(flagOf({ web_search_requests: 0, note: 'x' }), null);
  });
  it('a nested object member beside a readable 0 gives NULL', () => {
    assert.equal(flagOf({ web_search_requests: 0, x: { requests: 3 } }), null);
  });
  it('an unsafe integer member beside a readable 0 gives NULL', () => {
    assert.equal(flagOf({ web_search_requests: 0, y: 2 ** 53 }), null);
  });
  it('a null member beside a readable 0 gives NULL', () => {
    assert.equal(flagOf({ web_search_requests: 0, z: null }), null);
  });
  it('a negative or fractional member beside a readable 0 gives NULL', () => {
    assert.equal(flagOf({ web_search_requests: 0, a: -1 }), null);
    assert.equal(flagOf({ web_search_requests: 0, b: 0.5 }), null);
  });
});

describe('has_server_tool_use: present but unreadable is NULL, never 0 and never 1', () => {
  it('an empty object gives NULL', () => {
    assert.equal(flagOf({}), null);
  });
  it('a fractional member alone gives NULL', () => {
    assert.equal(flagOf({ web_search_requests: 1.5 }), null);
  });
  it('a negative member alone gives NULL', () => {
    assert.equal(flagOf({ web_search_requests: -1 }), null);
  });
  it('a string member alone gives NULL', () => {
    assert.equal(flagOf({ web_search_requests: '2' }), null);
  });
  it('a boolean member alone gives NULL', () => {
    assert.equal(flagOf({ web_search_requests: true }), null);
  });
  it('a member of 2^53 (not a safe integer) alone gives NULL', () => {
    assert.equal(flagOf({ web_search_requests: 2 ** 53 }), null);
  });
  it('an array, a string and null give NULL', () => {
    assert.equal(flagOf([1, 2]), null);
    assert.equal(flagOf('2'), null);
    assert.equal(flagOf(null), null);
  });
});

describe('allowlist and schema', () => {
  it('server_tool_use is the toolcount kind and iterations stays presence', () => {
    const byColumn = Object.fromEntries(ALLOWLIST.map((e) => [e.column, e]));
    assert.equal(byColumn.has_server_tool_use.kind, 'toolcount');
    assert.equal(byColumn.has_server_tool_use.source, 'message.usage.server_tool_use');
    assert.equal(byColumn.has_iterations.kind, 'presence');
  });
  it('the cc_message columns still equal the allowlist columns', () => {
    const ctx = makeHome();
    try {
      const db = openStore({ home: ctx.home });
      const cols = db.prepare("SELECT name FROM pragma_table_info('cc_message')").all().map((r) => r.name).sort();
      db.close();
      assert.deepEqual(cols, ALLOWLIST.map((e) => e.column).sort());
    } finally {
      ctx.cleanup();
    }
  });
});
