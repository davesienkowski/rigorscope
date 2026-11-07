// Plain period objects for the loader tests, built independently of src/measure/period.mjs (plan 01-08).
// A helper, not a test. Shape: { mode, tz, sinceMs, untilMs, sinceDate, untilDate, nowMs }; untilMs is exclusive.
export function periodOf({
  mode = 'all', tz = 'UTC', sinceMs = null, untilMs = null, sinceDate = null, untilDate = null, nowMs = null,
} = {}) {
  return {
    mode, tz, sinceMs, untilMs, sinceDate, untilDate, nowMs,
  };
}
