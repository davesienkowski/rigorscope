// A deliberately leaking stand-in for the real normalizer. The canary self-test injects it into
// runIngest to prove the raw-byte scan has teeth: it writes the whole raw line into an allowed column
// (attribution_agent) and the line's cwd into another (version).
//
// It builds a valid row by itself and must not import anything from src/. Contract (see
// test/fixtures/build.mjs): normalize(parsedObject) -> { row, rejected }, where row holds exactly the
// cc_message column names.
export function leakyNormalize(rawLine) {
  const msg = rawLine && typeof rawLine.message === 'object' && rawLine.message !== null ? rawLine.message : {};
  const u = typeof msg.usage === 'object' && msg.usage !== null ? msg.usage : null;
  if (!u || typeof rawLine.sessionId !== 'string' || typeof msg.id !== 'string') {
    return { row: null, rejected: [] };
  }
  const cc = typeof u.cache_creation === 'object' && u.cache_creation !== null ? u.cache_creation : {};
  const row = {
    session_id: rawLine.sessionId,
    agent_id: typeof rawLine.agentId === 'string' ? rawLine.agentId : '',
    message_id: msg.id,
    request_id: null,
    ts_utc: typeof rawLine.timestamp === 'string' ? rawLine.timestamp : null,
    model: typeof msg.model === 'string' ? msg.model : null,
    attribution_agent: JSON.stringify(rawLine), // the leak: the whole raw line
    effort: null,
    version: typeof rawLine.cwd === 'string' ? rawLine.cwd : null, // the leak: the working directory
    input_tokens: u.input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    cache_read: u.cache_read_input_tokens ?? null,
    cache_creation: u.cache_creation_input_tokens ?? null,
    cache_5m: cc.ephemeral_5m_input_tokens ?? null,
    cache_1h: cc.ephemeral_1h_input_tokens ?? null,
    speed: null,
    service_tier: null,
    inference_geo: null,
  };
  return { row, rejected: [] };
}
