// store.db schema version 6: has_server_tool_use becomes a tri-state count flag (plan 01-12, WR-03, U5, RR-04).
//
// Before plan 01-12 cc_message.has_server_tool_use stored only that message.usage.server_tool_use was present: a
// stored 1 meant "the key was there", and the counts were never stored, so every dollar of such a call carried the
// server-tool floor mark. The normalizer now stores 1 for a readable count above 0, 0 for an absent key or an object
// whose members are all readable 0s, and NULL otherwise (review CR-01). This migration:
//   - sets has_server_tool_use to NULL where it is 1 (a presence-only 1 is not a count: unknown, never 0 and never
//     a claimed 1), and keeps 0 as 0. The old 0 covers an absent key and also a present value that was not an object
//     (an array, a string, a number, null), which the store cannot tell apart; blanking every 0 would turn each
//     genuine absent key into an unknown, so the 0 is kept and a reread corrects it where the source still exists;
//   - sets head_hash to NULL on the transcript session and subagent files (the unit kinds that carry messages; meta
//     files carry none), so the next ingest classifies each as rewritten and rereads it from offset 0. The writer
//     merges a reread value into the stored one: a reread 1 refills the flag to 1, a reread NULL turns a stored 0
//     into NULL, and a reread 0 leaves a migrated NULL as NULL (since review CR-01 the writer keeps an unknown
//     against a 0 in either order and cannot tell a migrated NULL from another one: over-unknown, never a wrong 0).
// Rows whose source files have aged out stay NULL, which is the honest state. No row is deleted.
// A store migrated before review CR-01 was refilled by the earlier writer, coalesce(max(old, new), old, new), which
// set a migrated NULL to a reread 0 and kept a stored 0 against a reread NULL.
export const version = 6;

export const sql = `
UPDATE cc_message SET has_server_tool_use = NULL WHERE has_server_tool_use = 1;
UPDATE source_file SET head_hash = NULL
WHERE kind IN ('session', 'subagent')
  AND root_id IN (SELECT root_id FROM source_root WHERE source = 'transcript');
`;
