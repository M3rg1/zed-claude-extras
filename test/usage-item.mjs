/** The usage item: a short word in the row, with every limit and the prompt cache in
 *  its dropdown, and each kind of billing keeping its figures to itself.
 *
 *    node test/usage-item.mjs */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { usageOption } from "../lib/usage-item.mjs";
import claude, { windowsFromRateLimits } from "../providers/claude.mjs";
import { launchArgv, testEnv } from "./launch.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "usage-item-test-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-06T20:00:00Z");
const inHours = (hours) => new Date(NOW + hours * 3_600_000).toISOString();

// ---------------------------------------------------------------- the item

const windows = [
  { label: "5h", name: "5-hour", usedPercent: 23, resetsAt: inHours(2.5) },
  { label: "wk", name: "Weekly", usedPercent: 98, resetsAt: inHours(9.2) },
  { label: "wk Fable", name: "Weekly, Fable", usedPercent: 9, resetsAt: inHours(9.2) },
];
const base = { windows, cacheLeft: "60m", staleMinutes: null, marker: "🔴", markerAt: 90, now: NOW };
const names = (option) => option.options.map((o) => o.name);
const shown = (option) => option.options.find((o) => o.value === option.currentValue).name;

const option = usageOption(base);
assert.equal(shown(option), "🔴 Usage · 60m", "the row stays short, whichever limit is highest");
assert.deepEqual(names(option), [
  "🔴 Usage · 60m",
  "5-hour: 23% · resets in 2h",
  "Weekly: 98% · resets in 9h",
  "Weekly, Fable: 9% · resets in 9h",
  "Prompt cache: 60m left",
]);
assert.equal(new Set(option.options.map((o) => o.value)).size, 5, "values are unique");
assert.match(option.options[1].description, /^Resets /, "the hover says when");
assert.match(option.options[4].description, /estimate/i, "and that the cache time is a guess");

const quiet = windows.map((w) => ({ ...w, usedPercent: 10 }));
assert.equal(shown(usageOption({ ...base, windows: quiet })), "Usage · 60m", "no marker below the line");
const fable = [quiet[0], quiet[1], { ...quiet[2], usedPercent: 95 }];
assert.equal(shown(usageOption({ ...base, windows: fable })), "🔴 Usage · 60m", "any limit can raise the marker");
assert.equal(shown(usageOption({ ...base, marker: "" })), "Usage · 60m", "the marker can be off");

const cold = usageOption({ ...base, windows: quiet, cacheLeft: "cold" });
assert.equal(shown(cold), "Usage · cold");
assert.equal(names(cold).at(-1), "Prompt cache: cold");

const noCache = usageOption({ ...base, windows: quiet, cacheLeft: "" });
assert.equal(shown(noCache), "Usage", "with the estimate off, no trace of it");
assert.equal(noCache.options.length, 4);

const stale = usageOption({ ...base, windows: quiet, staleMinutes: 5 });
assert.equal(shown(stale), "Usage ? · 60m", "failing reads are admitted");
assert.match(stale.description, /last read 5m ago/);

// API billing has no plan limits, so "Usage" would promise figures that don't exist.
const api = usageOption({ ...base, windows: [], cacheLeft: "5m" });
assert.equal(shown(api), "cache 5m");
assert.deepEqual(names(api), ["cache 5m", "Prompt cache: 5m left"]);
assert.equal(usageOption({ ...base, windows: [], cacheLeft: "" }), null, "nothing to show, no item");

const bare = usageOption({ ...base, windows: [{ label: "5h", usedPercent: 42, resetsAt: null }], cacheLeft: "" });
assert.deepEqual(names(bare), ["Usage", "5h: 42%"], "with no name or reset time, what's known");

// ---------------------------------------------------------------- reading limits

const reported = {
  five_hour: { utilization: 23, resets_at: inHours(2.5) },
  seven_day: { utilization: 98, resets_at: inHours(9.2) },
  limits: [
    { kind: "session", group: "session", percent: 23, resets_at: inHours(2.5), scope: null },
    { kind: "weekly_all", group: "weekly", percent: 98, resets_at: inHours(9.2), scope: null },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 9,
      resets_at: inHours(9.2),
      scope: { model: { display_name: "Fable", id: null }, surface: null },
    },
    { kind: "monthly_all", group: "monthly_spend", percent: 40, resets_at: null, scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: null, resets_at: null, scope: null },
  ],
};
assert.deepEqual(
  windowsFromRateLimits(reported).map((w) => [w.name, w.label, w.usedPercent]),
  [
    ["5-hour", "5h", 23],
    ["Weekly", "wk", 98],
    ["Weekly, Fable", "wk Fable", 9],
    ["Monthly spend", "monthly spend", 40],
  ],
  "every limit, whatever its kind, and none without a figure",
);
assert.equal(windowsFromRateLimits(reported)[0].resetsAt, inHours(2.5));

const noFiveHour = { limits: [{ group: "session", percent: 5, resets_at: null, scope: null }, reported.limits[1]] };
assert.deepEqual(
  windowsFromRateLimits(noFiveHour).map((w) => w.name),
  ["Session", "Weekly"],
  "a session that isn't the 5-hour window isn't called that",
);

// The list is experimental upstream; losing it must not lose the usual two figures.
for (const limits of [undefined, []]) {
  assert.deepEqual(
    windowsFromRateLimits({ ...reported, limits }).map((w) => [w.name, w.label, w.usedPercent, w.resetsAt]),
    [
      ["5-hour", "5h", 23, inHours(2.5)],
      ["Weekly", "wk", 98, inHours(9.2)],
    ],
  );
}
assert.deepEqual(windowsFromRateLimits({ seven_day: { utilization: 3, resets_at: null } }).map((w) => w.label), ["wk"]);

const savedKey = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = "k";
assert.equal(claude.cacheId(), "claude-api", "API billing keeps its own figures");
process.env.ANTHROPIC_API_KEY = "";
assert.equal(claude.cacheId(), "claude", "a blank key means the subscription");
delete process.env.ANTHROPIC_API_KEY;
assert.equal(claude.cacheId(), "claude");
if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;

// ---------------------------------------------------------------- through the proxy

/** Runs a proxy like Zed, sends it `first` once it's up, and resolves to the last
 *  usage item it published once `done(item)` holds, or after 6 seconds. */
function lastItem(env, first, done) {
  const [command, args] = launchArgv({ viaLauncher: false });
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...testEnv(),
      ZED_AGENT_USAGE_PROVIDER_PATH: path.join(here, "fake-provider.mjs"),
      ZED_AGENT_USAGE_CACHE_DIR: scratch,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_PROMPT_CACHE_TTL: "",
      ...env,
    },
  });
  return new Promise((resolve) => {
    let item = null;
    const finish = () => {
      child.kill();
      resolve(item);
    };
    const timer = setTimeout(finish, 6_000);
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) !== -1) {
        const msg = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        const options = msg.result?.configOptions ?? msg.params?.update?.configOptions;
        const found = options?.find((o) => o.id === "_usage");
        if (found) item = found;
        if (found && done(found)) {
          clearTimeout(timer);
          finish();
        }
      }
    });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    first(send);
  });
}

const newThread = (send) => send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "." } });
const hasLimits = (item) => shown(item).startsWith("Usage");

const fresh = await lastItem({ ZED_AGENT_USAGE_CACHE: "off" }, newThread, hasLimits);
assert.equal(shown(fresh), "Usage · cold", "a new thread has nothing cached yet");
assert.deepEqual(names(fresh).slice(1), ["5h: 42%", "wk: 7%", "Prompt cache: cold"]);

// Two entries on one machine, sharing a snapshot folder, billed differently.
const subscription = { ZED_AGENT_USAGE_FAKE_CACHE_ID: "fake-sub" };
const apiKey = { ZED_AGENT_USAGE_FAKE_CACHE_ID: "fake-api", ZED_AGENT_USAGE_FAKE_UNAVAILABLE: "1" };
assert.equal(shown(await lastItem(subscription, newThread, hasLimits)), "Usage · cold");
const apiItem = await lastItem(apiKey, newThread, () => false);
assert.equal(shown(apiItem), "cache cold", "an API thread doesn't get the subscription's limits");
const again = await lastItem({ ...subscription, ZED_AGENT_USAGE_FAKE_UNAVAILABLE: "1" }, newThread, hasLimits);
assert.equal(shown(again), "Usage · cold", "the same billing still shares, and the API thread left it alone");

// A reopened thread: Zed's thread list says when it last moved.
const reopen = (minutesAgo) => ({
  ZED_AGENT_USAGE_CACHE: "off",
  ZED_AGENT_USAGE_LAST_ACTIVITY: "off",
  ZED_AGENT_USAGE_FAKE_SESSIONS: JSON.stringify(
    minutesAgo === null
      ? []
      : [{ sessionId: "old_thread", updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() }],
  ),
});
const openOld = (send) => {
  send({ jsonrpc: "2.0", id: 5, method: "session/list", params: {} });
  send({ jsonrpc: "2.0", id: 6, method: "session/load", params: { sessionId: "old_thread", cwd: ".", mcpServers: [] } });
};
const hasFigures = (item) => shown(item).includes("Usage");
const recent = await lastItem(reopen(10), openOld, (item) => hasFigures(item) && shown(item).includes("·"));
assert.equal(shown(recent), "Usage · 50m", "ten minutes ago, on an hour's cache");
const longAgo = await lastItem(reopen(120), openOld, (item) => hasFigures(item) && shown(item).includes("·"));
assert.equal(shown(longAgo), "Usage · cold", "two hours ago, on an hour's cache");
const unknown = await lastItem(reopen(null), openOld, hasFigures);
assert.equal(shown(unknown), "Usage", "no record of the thread: no guess");

console.log("PASS: the usage item stays short, lists every limit and keeps billing apart");
