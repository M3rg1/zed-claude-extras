/** Claude Code provider: usage via the Agent SDK's `get_usage` control request,
 *  the data behind `/usage`. The SDK authenticates itself and no model call is
 *  made, so no credentials are handled and no quota is used. */

import { homedir } from "node:os";
import path from "node:path";
import { expandPaths, firstExisting, resolveNodeAdapter, zedPaths } from "../lib/resolve.mjs";

const ADAPTER_REL =
  "external_agents/registry/npx/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
const SDK_REL =
  "external_agents/registry/npx/claude-acp/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";

async function loadSdk() {
  const entry = firstExisting([process.env.CLAUDE_AGENT_SDK, ...zedPaths(SDK_REL)]);
  if (!entry) {
    throw new Error(
      `@anthropic-ai/claude-agent-sdk not found. Set CLAUDE_AGENT_SDK to its sdk.mjs path.`,
    );
  }
  return import(`file://${entry}`);
}

/** Control requests need streaming input mode; staying silent keeps the session
 *  idle so no turn starts. */
function idlePrompt() {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    },
  };
}

const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** A limit's full and short names. Any kind of limit gets a usable name from its own
 *  data, so one added upstream shows up without a change here. */
function limitNames(limit, hasFiveHour) {
  const group = (limit.group ?? limit.kind ?? "limit").replaceAll("_", " ");
  let names = { name: capitalized(group), label: group };
  if (group === "weekly") names = { name: "Weekly", label: "wk" };
  // The list calls the 5-hour window "session", which reads like the current thread.
  if (group === "session" && hasFiveHour) names = { name: "5-hour", label: "5h" };
  const surface = limit.scope?.surface;
  const scope = limit.scope?.model?.display_name ?? (typeof surface === "string" ? surface : surface?.display_name);
  return scope ? { name: `${names.name}, ${scope}`, label: `${names.label} ${scope}` } : names;
}

/** The two usual limits from their named fields, for when the general list is missing:
 *  it's newer and just as experimental. Weekly prefers the all-models window, else the
 *  highest per-model one, so the figure shown is always the binding one. */
function namedWindows(limits) {
  const perModel = [limits.seven_day_opus, limits.seven_day_sonnet, limits.seven_day_oauth_apps]
    .filter((w) => w && typeof w.utilization === "number")
    .sort((a, b) => b.utilization - a.utilization);
  const weekly = limits.seven_day?.utilization != null ? limits.seven_day : perModel[0];

  const windows = [];
  if (typeof limits.five_hour?.utilization === "number") {
    windows.push({
      name: "5-hour",
      label: "5h",
      usedPercent: limits.five_hour.utilization,
      resetsAt: limits.five_hour.resets_at ?? null,
    });
  }
  if (typeof weekly?.utilization === "number") {
    windows.push({ name: "Weekly", label: "wk", usedPercent: weekly.utilization, resetsAt: weekly.resets_at ?? null });
  }
  return windows;
}

/** The SDK's `rate_limits` as our window list, in the order it reports them. */
export function windowsFromRateLimits(limits) {
  const hasFiveHour = typeof limits.five_hour?.utilization === "number";
  const listed = (Array.isArray(limits.limits) ? limits.limits : [])
    .filter((limit) => typeof limit?.percent === "number")
    .map((limit) => ({
      ...limitNames(limit, hasFiveHour),
      usedPercent: limit.percent,
      resetsAt: limit.resets_at ?? null,
    }));
  return listed.length ? listed : namedWindows(limits);
}

export default {
  id: "claude",
  displayName: "Claude",

  /** API billing has no plan limits, so one machine's API and subscription threads
   *  must not share a snapshot of them. */
  cacheId() {
    return process.env.ANTHROPIC_API_KEY ? "claude-api" : "claude";
  },

  resolveAdapter() {
    return resolveNodeAdapter({
      relative: ADAPTER_REL,
      npmPackage: "@agentclientprotocol/claude-agent-acp",
    });
  },

  /** Claude Code files a session under a folder named after its project. Searching
   *  by session id saves copying how it encodes paths, and finds a session started
   *  in a worktree too. */
  agentLogDir(sessionId) {
    const config = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
    return firstExisting(expandPaths(path.join(config, "projects"), ["*", sessionId, "subagents"]));
  },

  async fetchUsage({ cwd = process.cwd(), timeoutMs = 20_000 } = {}) {
    const { query } = await loadSdk();
    const q = query({
      prompt: idlePrompt(),
      options: { cwd, settingSources: [], mcpServers: {}, includePartialMessages: false },
    });

    // The transport only connects once the caller starts consuming.
    const drain = (async () => {
      try {
        for await (const _ of q) {
          /* no messages expected */
        }
      } catch {
        /* teardown races are expected */
      }
    })();

    const timer = setTimeout(() => q.close?.(), timeoutMs);
    try {
      const res = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      return {
        available: res.rate_limits_available === true,
        planType: res.subscription_type ?? null,
        windows: windowsFromRateLimits(res.rate_limits ?? {}),
      };
    } finally {
      clearTimeout(timer);
      q.close?.();
      try {
        await q.return?.(undefined);
      } catch {
        /* ignore */
      }
      void drain;
    }
  },
};
