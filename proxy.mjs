#!/usr/bin/env node
/**
 * ACP stdio proxy: Zed <--> proxy.mjs <--> claude-acp adapter.
 *
 * Appends a read-only usage selector to the session's config options and relays
 * everything else verbatim. A provider decides which agent to wrap and where the
 * numbers come from (see providers/README.md).
 *
 *   node proxy.mjs [--provider <id>]
 */

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProvider } from "./providers/index.mjs";
import {
  acquireFetchLock,
  cacheDir,
  readCache,
  waitForCache,
  writeCache,
} from "./lib/cache.mjs";
import { AgentLogReader, agentForValue, agentLogMarkdown, agentMapOption } from "./lib/agent-map.mjs";
import { CommandSummary, resolveCommandMax, shortenTitle } from "./lib/commands.mjs";
import { TurnTimes } from "./lib/turn-times.mjs";
import { SubagentFilter } from "./lib/subagents.mjs";
import { cacheLeft, cacheTtlMs } from "./lib/prompt-cache.mjs";
import { zedCli } from "./lib/resolve.mjs";
import { usageOption } from "./lib/usage-item.mjs";
import { clampPercent, formatWindows, msUntilNextReset } from "./lib/windows.mjs";

/** Usage only moves when a turn runs, so refreshes are triggered by turns --
 *  starting one and finishing one -- rather than by the clock.
 *
 *  MIN_AGE is the floor: however many chats fire triggers, a real fetch happens
 *  at most this often across every proxy on the machine. MAX_AGE is the ceiling:
 *  if nothing has triggered for that long, refresh anyway so a long-idle window
 *  is not showing yesterday's figures. Both are measured against the shared
 *  snapshot, which is how the interval is kept across chats and windows. */
const MIN_AGE_MS = Number(process.env.ZED_AGENT_USAGE_MIN_AGE_MS ?? 60_000);
const MAX_AGE_MS = Number(process.env.ZED_AGENT_USAGE_MAX_AGE_MS ?? 900_000);
// Labels count down, so they need re-rendering as time passes even when the
// numbers have not moved. Pure and cache-backed, so far cheaper than a fetch.
const RENDER_MS = Number(process.env.ZED_AGENT_USAGE_RENDER_MS ?? 30_000);
const DEBUG = process.env.ZED_AGENT_USAGE_DEBUG === "1";
const off = (v) => ["", "off", "none", "false", "0"].includes((v ?? "").toLowerCase());

/** Reuse a snapshot another proxy fetched within this window. Zed runs one proxy
 *  per window, so without this each pays for the same numbers. */
// `?? "on"` matters: off() counts an empty string as off, and unset must not.
const SHARING = !off(process.env.ZED_AGENT_USAGE_CACHE ?? "on");

/** Consecutive failed reads before the label admits it. Keyed on failure rather
 *  than age: idling on purpose is not the same as being unable to read, and an
 *  age-based marker flags every idle window for no reason. Two, so a single
 *  transient blip stays quiet. */
const STALE_AFTER_FAILURES = Number(process.env.ZED_AGENT_USAGE_STALE_AFTER ?? 2);

/** No turns for this long means nobody is working: stop the safety net entirely.
 *  Turn start is a trigger, so it refreshes the moment work resumes, and window
 *  resets still fire, which bounds how old the figures can get. */
const IDLE_AFTER_MS = Number(process.env.ZED_AGENT_USAGE_IDLE_AFTER_MS ?? 600_000);

/** Config-option ids to drop from the row. Useful for selectors you have already
 *  pinned in settings.json and do not want to look at. Run with
 *  ZED_AGENT_USAGE_DEBUG=1 to see the available ids. */
const HIDDEN = new Set(
  (process.env.ZED_AGENT_USAGE_HIDE ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

/** Warning glyph shown above MARKER_AT percent. An emoji because ACP has no
 *  colour or severity field. `off` disables it; any other value replaces it. */
const MARKER = (() => {
  const raw = process.env.ZED_AGENT_USAGE_MARKER;
  if (raw === undefined) return "🔴";
  return off(raw.trim()) ? "" : raw.trim();
})();
/** Percentage above which MARKER appears, 0-100. 0 warns at any usage, 100
 *  never does. */
const MARKER_AT = clampPercent(process.env.ZED_AGENT_USAGE_MARKER_AT, 90);

/** How long a thread's prompt cache lasts, or null with the estimate turned off. */
const PROMPT_CACHE_TTL_MS = off(process.env.ZED_AGENT_USAGE_PROMPT_CACHE ?? "on")
  ? null
  : cacheTtlMs(process.env);
/** How often the agent map looks for new subagents while a thread is in use. It only
 *  stats logs that haven't changed, but Zed rebuilds the row each time one has. */
const AGENT_MAP_MS = Number(process.env.ZED_AGENT_USAGE_AGENT_MAP_MS ?? 15_000);
const SHOW_AGENT_MAP = !off(process.env.ZED_AGENT_USAGE_AGENT_MAP ?? "on");
const COMMAND_MAX = resolveCommandMax(process.env.ZED_AGENT_USAGE_COMMAND_MAX);
const COMMAND_SUMMARY = off(process.env.ZED_AGENT_USAGE_COMMAND_SUMMARY ?? "on")
  ? null
  : new CommandSummary(COMMAND_MAX);
const SUBAGENT_FILTER = off(process.env.ZED_AGENT_USAGE_HIDE_SUBAGENTS ?? "on")
  ? null
  : new SubagentFilter();

/** Goes in front of every thread title. Zed gives all custom agents the same
 *  generic icon and has no setting for it, so the title is the one place in the
 *  sidebar that can say which agent entry a thread runs on. */
const TITLE_PREFIX = (process.env.ZED_AGENT_USAGE_TITLE_PREFIX ?? "").trim();
/** A card at the start and the end of each turn, with its times. `off` disables. */
const TURN_TIMES = off(process.env.ZED_AGENT_USAGE_TURN_TIMES ?? "on") ? null : new TurnTimes();

const log = (msg) => {
  if (DEBUG) process.stderr.write(`[zed-claude-extras] ${msg}\n`);
};

function providerId() {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf("--provider");
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1];
  const bare = argv.find((a) => !a.startsWith("-"));
  return bare ?? process.env.ZED_AGENT_USAGE_PROVIDER ?? "claude";
}

const provider = await loadProvider(providerId());

log(`provider: ${provider.id}, marker ${MARKER || "off"} above ${MARKER_AT}%`);

/** ACP reserves the `_` prefix for custom use, so this cannot collide with an
 *  option a real adapter grows later. */
const USAGE_OPTION_ID = "_usage";
const AGENT_MAP_OPTION_ID = "_agentMap";
/** Every injected id, so a set-request for any of them can be answered here. */
const OWN_OPTION_IDS = new Set([USAGE_OPTION_ID, AGENT_MAP_OPTION_ID]);

// ---------------------------------------------------------------- adapter

function adapterCommand() {
  if (process.env.ZED_AGENT_USAGE_ADAPTER_COMMAND) {
    return {
      command: process.env.ZED_AGENT_USAGE_ADAPTER_COMMAND,
      args: process.env.ZED_AGENT_USAGE_ADAPTER_ARGS
        ? JSON.parse(process.env.ZED_AGENT_USAGE_ADAPTER_ARGS)
        : [],
    };
  }
  return provider.resolveAdapter();
}

const { command, args } = adapterCommand();
log(`spawning adapter: ${command} ${args.join(" ")}`);

const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "inherit"], // stderr passes through to Zed's ACP log
  env: process.env,
});

child.on("error", (err) => {
  process.stderr.write(`[zed-claude-extras] failed to spawn adapter: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));

process.stdin.on("end", () => child.stdin.end());
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => child.kill(sig));
}

// ---------------------------------------------------------------- state

/** Whose figures these are. A provider whose limits depend on how it's billed names
 *  each kind, so threads billed differently don't read each other's snapshot. */
const USAGE_CACHE_ID = provider.cacheId?.() ?? provider.id;

/** Latest snapshot from the provider, or null until the first success. */
let usage = null;
let fetching = false;
/** When the current snapshot was read -- by us or by another proxy. */
let fetchedAt = 0;
/** Failed reads in a row; resets on any success. */
let failures = 0;
/** Last sign of someone actually working in this proxy. */
let lastTurnAt = Date.now();
/** Timer that re-reads usage just after a window rolls over. */
let resetTimer = null;
/** sessionId -> the adapter's own options, so each render starts from a clean
 *  set rather than appending to its own output. */
const rawConfigOptions = new Map();
/** sessionId -> the set Zed last got, as JSON. Zed rebuilds a thread's whole row on
 *  any update, closing a menu open in it, so a thread is only sent a set that changed. */
const publishedSets = new Map();
/** Request id -> sessionId, for responses that omit it. `session/load` carries
 *  the id only in the request, so a resumed thread would otherwise never be
 *  registered here and its label would freeze at whatever it loaded with. */
const pendingSessionIds = new Map();
/** Request id -> sessionId, for the requests whose response ends a summary card. */
const turnRequests = new Map();
/** sessionId -> { running, endedAt } of its last turn, for the cache estimate. */
const promptCacheTurns = new Map();
/** Request id -> sessionId, for the prompts still running. */
const promptRequests = new Map();
/** sessionId -> its subagents, for the agent map. */
const sessionAgents = new Map();
const agentLogReader = new AgentLogReader();
let readingAgents = false;

/** Minutes since the snapshot was read, or null while reads are healthy. */
function staleMinutes() {
  if (!fetchedAt || failures < STALE_AFTER_FAILURES) return null;
  return Math.floor((Date.now() - fetchedAt) / 60_000);
}

function promptCacheLeft(sessionId) {
  if (PROMPT_CACHE_TTL_MS === null) return "";
  return cacheLeft(promptCacheTurns.get(sessionId), PROMPT_CACHE_TTL_MS, Date.now());
}

function usageItem(sessionId) {
  return usageOption({
    windows: usage?.available ? usage.windows : [],
    cacheLeft: promptCacheLeft(sessionId),
    staleMinutes: staleMinutes(),
    marker: MARKER,
    markerAt: MARKER_AT,
    now: Date.now(),
  });
}

/** Gives a reopened thread a cache estimate before its next turn, from when the agent's
 *  own record says its last turn ended. A thread with no record shows none. */
async function recallLastTurn(sessionId) {
  if (PROMPT_CACHE_TTL_MS === null || !provider.lastTurnAt) return;
  try {
    const at = await provider.lastTurnAt(sessionId);
    const turn = promptCacheTurns.get(sessionId);
    if (!at || turn?.running || at <= (turn?.endedAt ?? 0)) return;
    promptCacheTurns.set(sessionId, { running: false, endedAt: at });
    renderSelectors();
  } catch (err) {
    log(`reading the last turn failed: ${err?.message || err}`);
  }
}

/** The row Zed renders: the adapter's options minus any hidden, plus ours. Kept
 *  options pass through untouched -- only the set membership changes. */
function withOwnOptions(configOptions, sessionId) {
  if (!Array.isArray(configOptions)) return configOptions;
  const kept = HIDDEN.size ? configOptions.filter((opt) => !HIDDEN.has(opt?.id)) : configOptions;
  const mine = [
    usageItem(sessionId),
    agentMapOption(sessionAgents.get(sessionId)),
  ].filter(Boolean);
  return mine.length ? [...kept, ...mine] : kept;
}

// ---------------------------------------------------------------- framing

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** `sessionId`'s full set, noted as what Zed now has. */
function setForZed(sessionId, configOptions) {
  const set = withOwnOptions(configOptions, sessionId);
  publishedSets.set(sessionId, JSON.stringify(set));
  return set;
}

/** Sends `sessionId` its set if it differs from what Zed has, or always with `force`.
 *  Zed only re-reads an item when the set is sent again. */
function publishSession(sessionId, { force = false } = {}) {
  const configOptions = rawConfigOptions.get(sessionId);
  if (!configOptions) return;
  if (!force && publishedSets.get(sessionId) === JSON.stringify(withOwnOptions(configOptions, sessionId))) return;
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: setForZed(sessionId, configOptions) },
    },
  });
}

/** Sends each open thread its set, where it changed. This also covers a cold start,
 *  where session/new beats the first fetch. */
function renderSelectors() {
  for (const sessionId of rawConfigOptions.keys()) publishSession(sessionId);
}

/** Re-reads each open thread's subagent logs, telling Zed only if a row changed. */
async function refreshAgentMaps() {
  if (!SHOW_AGENT_MAP || !provider.agentLogDir || readingAgents) return;
  readingAgents = true;
  try {
    for (const sessionId of rawConfigOptions.keys()) {
      const dir = provider.agentLogDir(sessionId);
      sessionAgents.set(sessionId, dir ? await agentLogReader.read(dir, Date.now()) : []);
    }
    renderSelectors();
  } catch (err) {
    log(`reading subagent logs failed: ${err?.message || err}`);
  } finally {
    readingAgents = false;
  }
}

/** Opens a readable copy of a subagent's log in Zed. A value that names no agent of
 *  this thread does nothing, as Zed may replay a saved value when a thread starts. */
async function openAgentLog(sessionId, value) {
  const agent = agentForValue(sessionAgents.get(sessionId), value);
  if (!agent) return;
  try {
    const file = path.join(cacheDir(), `agent-${agent.id}.md`);
    await writeFile(file, agentLogMarkdown(agent, await readFile(agent.logPath, "utf8")), { mode: 0o600 });
    const { command, args } = zedCli();
    const zed = spawn(command, [...args, "--existing", file], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    zed.on("error", (err) => log(`opening a subagent log failed: ${err.message}`));
    zed.unref();
  } catch (err) {
    log(`opening a subagent log failed: ${err?.message || err}`);
  }
}

/** A rolled-over window leaves a stale percentage cached, so re-read just after
 *  the soonest reset. */
function scheduleResetRefresh() {
  clearTimeout(resetTimer);
  const due = msUntilNextReset(usage?.windows);
  if (due == null) return;
  // Slack, and never a busy loop on a past timestamp.
  resetTimer = setTimeout(
    () => void refreshUsage({ maxAge: 0, reason: "window reset" }),
    Math.max(due, 0) + 2_000,
  );
  resetTimer.unref?.();
}

/** Refresh if the shared snapshot is older than `maxAge`.
 *
 *  Only one process fetches: the lock winner spawns the provider, everyone else
 *  waits for its result. Without that, proxies started together would all miss
 *  the cache and all spawn at once. */
async function refreshUsage({ maxAge = MIN_AGE_MS, reason = "" } = {}) {
  if (fetching) return;
  fetching = true;
  try {
    const shared = SHARING ? readCache(USAGE_CACHE_ID, maxAge) : null;
    if (shared) {
      adopt(shared, `${reason} (shared)`);
      return;
    }

    let release = SHARING ? acquireFetchLock(USAGE_CACHE_ID) : () => {};
    if (!release) {
      const waited = await waitForCache(USAGE_CACHE_ID, MAX_AGE_MS);
      if (waited) {
        adopt(waited, `${reason} (published by another proxy)`);
        return;
      }
      // The holder died or is slower than our patience. Showing nothing is the
      // worst outcome, so do the work here rather than return empty-handed.
      log(`${reason}: waited but no snapshot appeared; fetching here instead`);
      release = () => {};
    }

    try {
      const next = await provider.fetchUsage();
      const snapshot = { fetchedAt: Date.now(), usage: next };
      if (SHARING) writeCache(USAGE_CACHE_ID, snapshot);
      adopt(snapshot, `${reason} (fetched)`);
    } finally {
      release();
    }
  } catch (err) {
    failures += 1;
    log(`usage fetch failed (${failures} in a row): ${err?.message || err}`);
    renderSelectors(); // the label may need to admit it now
  } finally {
    fetching = false;
  }
}

/** Take a snapshot as current, whoever produced it. */
function adopt(snapshot, note) {
  failures = 0;
  usage = snapshot.usage;
  fetchedAt = snapshot.fetchedAt;
  log(`usage:${formatWindows(usage.windows) || " (none)"} ${note}`);
  renderSelectors();
  scheduleResetRefresh();
}

/** Tells Zed a session's summary card is done, if it has one open. */
function finishCommandCard(sessionId) {
  const update = COMMAND_SUMMARY?.finishCard(sessionId);
  if (update) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

/** A title can already carry the prefix: Zed passes a title back to the agent,
 *  and a reopened thread's stored title is published again. */
function withTitlePrefix(title) {
  return title.startsWith(`${TITLE_PREFIX} `) ? title : `${TITLE_PREFIX} ${title}`;
}

/** Inspect one agent -> client message, decorating the selector in place. Returns
 *  what to send on, or null for nothing. */
function transform(message) {
  // Only a response can answer one of our recorded requests; an agent->client
  // request has its own id space and must not consume the entry.
  const isResponse = message?.id !== undefined && ("result" in message || "error" in message);
  const answered = isResponse ? pendingSessionIds.get(message.id) : undefined;
  if (isResponse) pendingSessionIds.delete(message.id);
  // Close the card first, so it never trails the end of its own turn.
  if (isResponse && turnRequests.has(message.id)) {
    finishCommandCard(turnRequests.get(message.id));
    turnRequests.delete(message.id);
  }
  // After the summary card, so the turn's last card is its end.
  const turnEnd = isResponse ? TURN_TIMES?.end(message, Date.now()) : null;
  if (turnEnd) send({ jsonrpc: "2.0", method: "session/update", params: turnEnd });
  if (isResponse && promptRequests.has(message.id)) {
    promptCacheTurns.set(promptRequests.get(message.id), { running: false, endedAt: Date.now() });
    promptRequests.delete(message.id);
    renderSelectors();
  }

  // Config options arrive on the session/new and session/load responses.
  if (message?.result?.configOptions) {
    const { configOptions } = message.result;
    const sessionId = message.result.sessionId ?? answered;
    if (sessionId) rawConfigOptions.set(sessionId, configOptions);
    // A brand new thread: only session/new gets here with no session id in its request,
    // and nothing is cached before its first turn.
    if (sessionId && !answered && !promptCacheTurns.has(sessionId)) {
      promptCacheTurns.set(sessionId, { running: false, endedAt: 0 });
    }
    if (sessionId && answered) void recallLastTurn(sessionId);
    log(`config options: ${configOptions.map((o) => o?.id).join(", ")}`);
    // Startup fetch failed or has not landed: retry so the label arrives now.
    if (!usage) void refreshUsage({ reason: "session start" });
    void refreshAgentMaps();
    return {
      ...message,
      result: {
        ...message.result,
        configOptions: sessionId ? setForZed(sessionId, configOptions) : withOwnOptions(configOptions, sessionId),
      },
    };
  }

  if (
    message?.method === "session/request_permission" &&
    (COMMAND_SUMMARY || SUBAGENT_FILTER) &&
    message.params?.toolCall
  ) {
    finishCommandCard(message.params.sessionId);
    let toolCall = message.params.toolCall;
    if (SUBAGENT_FILTER) toolCall = SUBAGENT_FILTER.approve(toolCall);
    if (COMMAND_SUMMARY) toolCall = COMMAND_SUMMARY.approve(toolCall);
    return { ...message, params: { ...message.params, toolCall } };
  }

  if (message?.method !== "session/update") return message;
  const sessionId = message.params?.sessionId;
  const update = message.params?.update;
  if (!sessionId || !update) return message;

  // Before the summary card, so a subagent's work neither shows nor splits it.
  if (SUBAGENT_FILTER?.hides(update)) return null;

  // Only session/update is rewritten: session/request_permission keeps the whole
  // command, so what the user approves is never cut short.
  if (COMMAND_SUMMARY?.endsCard(update)) finishCommandCard(sessionId);
  let shown = update;
  if (COMMAND_SUMMARY) shown = COMMAND_SUMMARY.filter(sessionId, update);
  else if (COMMAND_MAX !== null && update.kind === "execute") shown = shortenTitle(update, COMMAND_MAX);
  if (shown === null) return null;
  if (shown !== update) return { ...message, params: { ...message.params, update: shown } };

  // Re-inject when the adapter republishes its set, e.g. after a mode switch.
  if (update.sessionUpdate === "config_option_update") {
    rawConfigOptions.set(sessionId, update.configOptions);
    return {
      ...message,
      params: {
        ...message.params,
        update: { ...update, configOptions: setForZed(sessionId, update.configOptions) },
      },
    };
  }

  // A null title clears it, and most of these updates carry no title at all.
  if (
    TITLE_PREFIX &&
    update.sessionUpdate === "session_info_update" &&
    typeof update.title === "string"
  ) {
    return {
      ...message,
      params: { ...message.params, update: { ...update, title: withTitlePrefix(update.title) } },
    };
  }

  // Turn end: the one moment the numbers are guaranteed to have moved.
  if (update.sessionUpdate === "usage_update") {
    lastTurnAt = Date.now();
    void refreshUsage({ reason: "turn end" });
  }

  return message;
}

// ------------------------------------------------- relay: client -> agent

/** The adapter has never heard of our id, so it would reject the set-request
 *  Zed sends on click. Answer it here, with the full set the schema requires. */
function interceptFromClient(message) {
  // Remember which session a request belongs to; its response may not say.
  if (message?.id !== undefined && message.params?.sessionId) {
    pendingSessionIds.set(message.id, message.params.sessionId);
  }
  // Replaying a thread reports its old commands, so a load gets a card as well.
  if (message?.method === "session/prompt" || message?.method === "session/load") {
    finishCommandCard(message.params?.sessionId);
    turnRequests.set(message.id, message.params?.sessionId);
  }
  if (message?.method === "session/prompt") {
    if (message.id !== undefined && message.params?.sessionId) {
      const turnStart = TURN_TIMES?.start(message.id, message.params.sessionId, Date.now());
      if (turnStart) send({ jsonrpc: "2.0", method: "session/update", params: turnStart });
    }
    promptCacheTurns.set(message.params?.sessionId, { running: true, endedAt: 0 });
    promptRequests.set(message.id, message.params?.sessionId);
    renderSelectors();
    // Turn start: worth a look before the user commits to a prompt.
    lastTurnAt = Date.now();
    void refreshUsage({ reason: "turn start" });
  }

  // An archived or closed thread must stop being re-rendered.
  if (message?.method === "session/close" || message?.method === "session/delete") {
    const gone = message.params?.sessionId;
    if (gone && rawConfigOptions.delete(gone)) log(`forgot session ${gone}`);
    if (gone) publishedSets.delete(gone);
    if (gone) promptCacheTurns.delete(gone);
    if (gone) sessionAgents.delete(gone);
  }

  if (message?.method !== "session/set_config_option") return false;
  if (!OWN_OPTION_IDS.has(message.params?.configId)) return false;
  const sessionId = message.params?.sessionId;
  log(`answering set_config_option for ${message.params.configId} (session ${sessionId})`);
  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { configOptions: withOwnOptions(rawConfigOptions.get(sessionId) ?? [], sessionId) },
    });
  }
  if (message.params.configId === AGENT_MAP_OPTION_ID) void openAgentLog(sessionId, message.params.value);
  // Zed may already show the clicked row as selected; this puts the summary back,
  // and only in the clicked thread.
  publishSession(sessionId, { force: true });
  return true;
}

let upstream = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  upstream += chunk;
  let index;
  while ((index = upstream.indexOf("\n")) !== -1) {
    const line = upstream.slice(0, index);
    upstream = upstream.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      child.stdin.write(`${line}\n`); // not JSON: pass through untouched
      continue;
    }
    try {
      if (interceptFromClient(message)) continue;
    } catch (err) {
      log(`intercept failed, forwarding: ${err?.message || err}`);
    }
    child.stdin.write(`${line}\n`);
  }
});

// ------------------------------------------------- relay: agent -> client

let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${line}\n`); // not JSON: pass through untouched
      continue;
    }
    try {
      const shown = transform(message);
      if (shown) send(shown);
    } catch (err) {
      log(`transform failed, passing through: ${err?.message || err}`);
      process.stdout.write(`${line}\n`);
    }
  }
});
child.stdout.on("end", () => {
  if (buffer.trim()) process.stdout.write(`${buffer}\n`);
});

void refreshUsage({ reason: "startup" });
// Safety net, but only while someone is working. An idle Zed costs nothing.
// Checking more often than MAX_AGE is pointless; less often would overshoot it.
setInterval(
  () => {
    if (Date.now() - lastTurnAt > IDLE_AFTER_MS) return;
    void refreshUsage({ maxAge: MAX_AGE_MS, reason: "between turns" });
  },
  Math.max(2_000, Math.min(60_000, MAX_AGE_MS)),
).unref();
// Subagents work during a turn, however long it has run, so a running turn isn't idle.
setInterval(() => {
  if (promptRequests.size === 0 && Date.now() - lastTurnAt > IDLE_AFTER_MS) return;
  void refreshAgentMaps();
}, AGENT_MAP_MS).unref();
// Re-render between fetches so the countdown stays honest without a turn.
setInterval(renderSelectors, RENDER_MS).unref();
