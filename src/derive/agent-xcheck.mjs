// The COST-06 agent-name cross-check (plan 01-07, D-06). Pure: no database access.
//
// For each joined call the OTel `agent.name` of its request is compared with the role the TRANSCRIPT gave it
// (attribution, meta or transcript main; never a role parsed from OTel). The OTel name is never a role source:
// this module only classifies and counts. States, checked in this order:
//
//   not_joined          the call or request joined nothing (every otel_only call)
//   no_name             the request carries no agent name (null, undefined, empty or not a string)
//   custom              the name is the literal `custom` (custom agents are not named in OTel)
//   no_transcript_role  the transcript gave no role (null, undefined or empty)
//   agree               the name equals the transcript role byte for byte
//   disagree            anything else
//
// Names are compared byte for byte: no trimming, no case folding, no Unicode normalization.
export const XCHECK_STATES = Object.freeze(['agree', 'disagree', 'custom', 'no_name', 'no_transcript_role', 'not_joined']);

const present = (v) => typeof v === 'string' && v.length > 0;

export function classifyAgentName({ joined, agentName, transcriptRole } = {}) {
  if (!joined) return 'not_joined';
  if (!present(agentName)) return 'no_name';
  if (agentName === 'custom') return 'custom';
  if (!present(transcriptRole)) return 'no_transcript_role';
  return agentName === transcriptRole ? 'agree' : 'disagree';
}

// Counts of each state (0 when absent) plus compared = agree + disagree. An unknown state throws.
export function tallyXcheck(states) {
  const out = Object.fromEntries(XCHECK_STATES.map((s) => [s, 0]));
  for (const s of states) {
    if (typeof s !== 'string' || !XCHECK_STATES.includes(s)) throw new RangeError('unknown cross-check state');
    out[s] += 1;
  }
  out.compared = out.agree + out.disagree;
  return out;
}
