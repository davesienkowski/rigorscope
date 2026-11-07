// Known-bad subject for test/prohibitions/server-tool-floor.test.mjs: the pre-01-12 presence rule, where any
// server_tool_use value that is not undefined (0 included) marks the message part a server-tool floor. A
// self-contained stub: it prices nothing real and imports nothing from src.
export function pricePart(part, ctx = {}) {
  const floor = part.kind === 'message' && ctx.serverToolUse !== undefined;
  return {
    status: 'priced', priceModel: part.model, tier: 'standard', geoUs: 0, costNano: 0,
    floor, floorReason: floor ? 'server_tool_use' : null,
  };
}
