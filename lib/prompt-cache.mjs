/** An estimate of how long a thread's prompt cache has left. Nothing reports this
 *  live: the API only says what each finished request read and wrote, so this
 *  counts down from the end of the last turn, as Claude Code's VS Code extension
 *  does. It can't see compaction or the cache being dropped early. */

const HOUR_MS = 3_600_000;
const FIVE_MINUTES_MS = 300_000;

/** The main conversation's cache lifetime in Claude Code: its override if set,
 *  else an hour on a subscription and 5 minutes with an API key. The
 *  `promptCacheTtl` setting isn't read here. */
export function cacheTtlMs(env) {
  const override = env.CLAUDE_CODE_PROMPT_CACHE_TTL;
  if (override === "1h") return HOUR_MS;
  if (override === "5m") return FIVE_MINUTES_MS;
  return env.ANTHROPIC_API_KEY ? FIVE_MINUTES_MS : HOUR_MS;
}

/** The label for a thread's `{ running, endedAt }` turn state at time `now`, or ""
 *  when no turn has run in this process. While a turn runs the cache is in use, so
 *  it counts as full. Times are epoch ms. */
export function cacheLabel(turn, ttlMs, now) {
  if (!turn) return "";
  const left = turn.running ? ttlMs : turn.endedAt + ttlMs - now;
  return left > 0 ? `cache ${Math.ceil(left / 60_000)}m` : "cache cold";
}
