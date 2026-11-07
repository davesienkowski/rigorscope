// Role precedence from transcript data (COST-02). Pure: no database access, no normalization.
//
//   1. attribution  the line's attributionAgent (non-empty)                    source transcript
//   2. meta         the sub-agent meta agentType, for a non-empty agent id      source transcript
//   3. main         a main-thread line (agent id is the empty string)           source derived
//   4. none         anything else: role unknown                                 source unavailable
//
// `meta` reports the meta agent type whenever one exists; `conflict` is 1 when the attribution and the
// meta type both exist and differ, 0 when both exist and agree, null otherwise. Names are compared
// byte-exactly: no trimming, no case folding (they passed their shape check at ingest). The OTel
// query_source steps of the full precedence are resolveFullRole below (plan 01-07).
import { harnessRole, isHarnessSource, isMainThreadSource, parseQuerySourceRole } from './query-source.mjs';

const present = (v) => typeof v === 'string' && v.length > 0;

export function resolveRole({ attribution = null, metaType = null, agentId } = {}) {
  const attr = present(attribution) ? attribution : null;
  const meta = present(metaType) ? metaType : null;
  const conflict = attr !== null && meta !== null ? (attr === meta ? 0 : 1) : null;
  if (attr !== null) return { role: attr, rule: 'attribution', source: 'transcript', meta, conflict };
  if (meta !== null && present(agentId)) return { role: meta, rule: 'meta', source: 'transcript', meta, conflict };
  if (agentId === '') return { role: 'main', rule: 'main', source: 'derived', meta, conflict };
  return { role: 'unknown', rule: 'none', source: 'unavailable', meta, conflict };
}


// The full role precedence (plan 01-07, COST-02, COST-03, D-06): the OTel query_source rules layered over the
// transcript rules of resolveRole, which keeps its exact return shape. First match wins:
//
//   1. harness            query_source is one of the six pure-harness sources: harness:<qs>   source otel
//   2. attribution        (resolveRole)                                                       source transcript
//   3. meta               (resolveRole)                                                       source transcript
//   4. main               (resolveRole: agent id is the empty string)                         source derived
//   5. query_source       agent:builtin:<Name> with a shape-valid Name: Name                  source otel
//   6. query_source_main  repl_main_thread or repl_main_thread:...: main                      source otel
//   7. none               role unknown                                                        source unavailable
//
// qsRole is the parse of the query source (step 5) whatever rule won; qsConflict is 1 when qsRole exists and
// differs from a role chosen by steps 2 to 4, 0 when it equals it, null otherwise (no qsRole, or the role came
// from the harness or query_source rule). Without a query source (undefined) the result is resolveRole's plus
// qsRole and qsConflict null. The OTel agent.name is never an input here (D-06).
export const FULL_ROLE_RULES = Object.freeze(['harness', 'attribution', 'meta', 'main', 'query_source', 'query_source_main', 'none']);

export function resolveFullRole({ attribution = null, metaType = null, agentId, querySource } = {}) {
  const base = resolveRole({ attribution, metaType, agentId });
  if (querySource === undefined) return { ...base, qsRole: null, qsConflict: null };
  const qsRole = parseQuerySourceRole(querySource);
  const { meta, conflict } = base;
  if (isHarnessSource(querySource)) {
    return { role: harnessRole(querySource), rule: 'harness', source: 'otel', meta, conflict, qsRole, qsConflict: null };
  }
  if (base.rule !== 'none') return { ...base, qsRole, qsConflict: qsRole === null ? null : (qsRole === base.role ? 0 : 1) };
  if (qsRole !== null) return { role: qsRole, rule: 'query_source', source: 'otel', meta, conflict, qsRole, qsConflict: null };
  if (isMainThreadSource(querySource)) {
    return { role: 'main', rule: 'query_source_main', source: 'otel', meta, conflict, qsRole, qsConflict: null };
  }
  return { ...base, qsRole, qsConflict: null };
}
