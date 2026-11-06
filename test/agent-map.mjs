/** The agent map: one item listing a thread's subagents, read from the logs Claude
 *  Code writes, where clicking a row opens that subagent's log.
 *
 *    node test/agent-map.mjs */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentLogReader, agentForValue, agentLogMarkdown, agentMapOption } from "../lib/agent-map.mjs";
import { launchArgv, testEnv } from "./launch.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "agent-map-test-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-06T12:00:00Z");
const MINUTE = 60_000;

const usage = (input, cacheRead, cacheWrite, output) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
});
const at = (minutesAgo, seconds = 0) => new Date(NOW - minutesAgo * MINUTE + seconds * 1000).toISOString();

/** Writes one subagent's two files, shaped like Claude Code's. */
function writeAgent(dir, id, { meta, lines, modifiedAt = NOW }) {
  mkdirSync(dir, { recursive: true });
  const log = path.join(dir, `agent-${id}.jsonl`);
  writeFileSync(log, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
  utimesSync(log, new Date(modifiedAt), new Date(modifiedAt));
  if (meta) writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
  return log;
}

const reviewMeta = {
  agentType: "playbook:reviewer",
  description: "Review the change",
  model: "opus",
  finished: true,
};
const reviewLines = [
  { type: "user", timestamp: at(90), message: { role: "user", content: "Review this diff." } },
  {
    type: "assistant",
    timestamp: at(89),
    message: { role: "assistant", usage: usage(1, 1000, 100, 50), content: [{ type: "text", text: "Reading." }] },
  },
  {
    type: "assistant",
    timestamp: at(90, 83), // 1m 23s after the first line
    message: { role: "assistant", usage: usage(2, 80_000, 200, 98), content: [{ type: "text", text: "All good." }] },
  },
];

// ---------------------------------------------------------------- reading logs

const dir = path.join(scratch, "subagents");
writeAgent(dir, "done", { meta: reviewMeta, lines: reviewLines, modifiedAt: NOW - 80 * MINUTE });
writeAgent(dir, "live", {
  meta: { agentType: "playbook:implementer", description: "Implement Task 6" },
  lines: [
    // Started before "done", so only its status can put it first.
    { type: "user", timestamp: at(95), message: { role: "user", content: "Build it." } },
    { type: "assistant", timestamp: at(94), message: { role: "assistant", usage: usage(0, 950, 0, 0), content: [] } },
    '{"type":"assistant","timestamp":"cut off mid-wri',
  ],
  modifiedAt: NOW - MINUTE,
});
writeAgent(dir, "gone", {
  meta: { agentType: "playbook:fix-implementer", description: "Fix round 1" },
  lines: [{ type: "user", timestamp: at(300), message: { role: "user", content: "Fix it." } }],
  modifiedAt: NOW - 31 * MINUTE,
});
writeAgent(dir, "bare", {
  lines: [{ type: "user", timestamp: at(200), message: { role: "user", content: "No metadata beside me." } }],
  modifiedAt: NOW - 200 * MINUTE,
});

const reader = new AgentLogReader();
const agents = await reader.read(dir, NOW);
const byId = Object.fromEntries(agents.map((a) => [a.id, a]));

assert.deepEqual(
  agents.map((a) => a.id),
  ["live", "done", "bare", "gone"],
  "running first, then newest first",
);
assert.equal(byId.done.status, "done");
assert.equal(byId.done.description, "Review the change");
assert.equal(byId.done.type, "playbook:reviewer");
assert.equal(byId.done.seconds, 83, "from its first log entry to its last");
assert.equal(byId.done.tokens, 80_300, "the last reply's context and output, not a sum over replies");
assert.equal(byId.live.status, "running", "unfinished, and written to recently");
assert.equal(byId.live.tokens, 950, "a half-written last line is skipped, not fatal");
assert.equal(byId.gone.status, "quiet", "unfinished, but its log has stopped moving");
assert.equal(byId.bare.status, "quiet");
assert.equal(byId.bare.description, "bare", "with no metadata, the id still names it");
assert.equal(byId.bare.tokens, 0);

assert.deepEqual(await reader.read(path.join(scratch, "nowhere"), NOW), [], "no folder yet means no agents");

// A log that changes is read again; one that doesn't isn't, so a long thread's
// finished agents cost a stat rather than a parse on every refresh.
const changing = path.join(scratch, "changing");
const log = writeAgent(changing, "a", { meta: reviewMeta, lines: reviewLines, modifiedAt: NOW - 90 * MINUTE });
const cached = new AgentLogReader();
assert.equal((await cached.read(changing, NOW))[0].tokens, 80_300);
const sameSize = readFileSync(log, "utf8").replace("80000", "70000");
writeFileSync(log, sameSize);
utimesSync(log, new Date(NOW - 90 * MINUTE), new Date(NOW - 90 * MINUTE));
assert.equal((await cached.read(changing, NOW))[0].tokens, 80_300, "unchanged size and time: not re-read");
utimesSync(log, new Date(NOW - 89 * MINUTE), new Date(NOW - 89 * MINUTE));
assert.equal((await cached.read(changing, NOW))[0].tokens, 70_300, "a newer log is re-read");
rmSync(log);
assert.deepEqual(await cached.read(changing, NOW), [], "a deleted log leaves the list");

// ---------------------------------------------------------------- the item

assert.equal(agentMapOption([]), null, "no subagents, no item");

const option = agentMapOption(agents);
const names = option.options.map((o) => o.name);
const shown = option.options.find((o) => o.value === option.currentValue);
assert.equal(shown.name, "4 agents · 1 running", "the row shows the summary, not one agent");
assert.equal(new Set(option.options.map((o) => o.value)).size, option.options.length, "values are unique");
assert.equal(names[1], "● Implement Task 6 · 1m · 950");
assert.equal(names[2], "○ Review the change · 1m · 80.3k");
assert.match(option.options[2].description, /1m 23s · 80\.3k tokens/, "the hover keeps the exact figures");
assert.match(option.options[2].description, /playbook:reviewer/);
assert.match(option.options[2].description, /Review the change/);
assert.equal(names[4], "◌ Fix round 1", "gone quiet has its own mark, and zero figures stay out");
assert.equal(agentForValue(agents, option.options[2].value), byId.done);
assert.equal(agentForValue(agents, option.currentValue), undefined, "the summary row is no agent");

assert.equal(agentMapOption(agents.slice(1)).options[0].name, "3 agents", "nothing running: no count of it");
assert.equal(agentMapOption(agents.slice(1, 2)).options[0].name, "1 agent");

const long = agentMapOption([
  { ...byId.done, description: "Implement Task 5: UI content and event wiring" },
]).options[1];
assert.equal(long.name, "○ Implement Task 5:… · 1m · 80.3k", "a long title gives way to the figures");
assert.match(long.description, /Implement Task 5: UI content and event wiring/, "the hover keeps it whole");

// Zed cuts a row at about 35 characters, so the figures have to fit inside that,
// however large they get.
const biggest = agentMapOption([
  { ...byId.done, description: "Implement Task 13: A mutation run on the branch", seconds: 6533, tokens: 252_200 },
]).options[1];
assert.equal(biggest.name, "○ Implement Task 13… · 108m · 252k");
assert.match(biggest.description, /108m 53s · 252\.2k tokens/);
assert.ok(Array.from(biggest.name).length <= 34, `too wide for Zed: ${biggest.name}`);

// ---------------------------------------------------------------- the log view

const toolFence = "```";
const markdown = agentLogMarkdown(byId.done, [
  JSON.stringify(reviewLines[0]),
  "not json at all",
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private musings" },
        { type: "text", text: "Looking at it." },
        { type: "tool_use", name: "Read", input: { file_path: "src/a.cpp" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", content: [{ type: "text", text: `${toolFence}\nold ${"x".repeat(5000)}` }] }],
    },
  }),
].join("\n"));
assert.match(markdown, /^# Review the change/);
assert.match(markdown, /playbook:reviewer/);
assert.match(markdown, /Review this diff\./, "the subagent's brief");
assert.match(markdown, /Looking at it\./);
assert.match(markdown, /Read/);
assert.match(markdown, /src\/a\.cpp/);
assert.ok(!markdown.includes("private musings"), "thinking stays out");
assert.ok(!markdown.includes("x".repeat(5000)), "a huge tool result is cut");
assert.match(markdown, /````\n```\nold x/, "a fence inside a result can't close its block");

// ---------------------------------------------------------------- through the proxy

/** Runs the proxy like Zed, hands it one thread, and gives `script` the means to
 *  drive it. Resolves to everything Zed was sent. */
function throughProxy(env, script) {
  const [command, args] = launchArgv({ viaLauncher: false });
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...testEnv(),
      ZED_AGENT_USAGE_PROVIDER_PATH: path.join(here, "fake-provider.mjs"),
      ZED_AGENT_USAGE_CACHE: "off",
      ZED_AGENT_USAGE_CACHE_DIR: path.join(scratch, "cache"),
      ZED_AGENT_USAGE_ZED_COMMAND: process.execPath,
      ZED_AGENT_USAGE_ZED_ARGS: JSON.stringify([path.join(here, "fake-zed.mjs")]),
      ZED_AGENT_USAGE_AGENT_MAP_MS: "100",
      ...env,
    },
  });
  const seen = [];
  const waiters = [];
  const settle = () => {
    for (const w of [...waiters]) {
      if (seen.some(w.test)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };
  const until = (test, what) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 10_000);
      waiters.push({
        test,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
      settle();
    });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      seen.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
    }
    settle();
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "." } });
  return script({ seen, send, until }).finally(() => child.kill());
}

const optionsIn = (msg) => msg.result?.configOptions ?? msg.params?.update?.configOptions;
const mapIn = (msg) => optionsIn(msg)?.find((o) => o.id === "_agentMap");
const lastMap = (seen) => seen.filter(mapIn).at(-1) && mapIn(seen.filter(mapIn).at(-1));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const threadDir = path.join(scratch, "thread");
const realNow = Date.now();
writeAgent(threadDir, "first", {
  meta: reviewMeta,
  lines: reviewLines,
  modifiedAt: realNow - 80 * MINUTE,
});

const launches = path.join(scratch, "launches.txt");
const clickEnv = { ZED_AGENT_USAGE_FAKE_AGENTS_DIR: threadDir, ZED_AGENT_USAGE_FAKE_ZED_LOG: launches };

await throughProxy(clickEnv, async ({ seen, send, until }) => {
  await until((m) => mapIn(m), "the item to appear");
  assert.equal(lastMap(seen).options[1].name, "○ Review the change · 1m · 80.3k");

  // A new subagent shows up without any turn or click.
  writeAgent(threadDir, "second", {
    meta: { agentType: "playbook:implementer", description: "Implement Task 7" },
    lines: [{ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "Go." } }],
    modifiedAt: Date.now(),
  });
  await until((m) => mapIn(m)?.options.some((o) => o.name.startsWith("● Implement Task 7")), "the new subagent");

  // Clicking a row: answered here, the log opens, and the row keeps its summary.
  const row = lastMap(seen).options.find((o) => o.name.startsWith("○ Review the change"));
  const seenBefore = seen.length;
  send({
    jsonrpc: "2.0",
    id: 7,
    method: "session/set_config_option",
    params: { sessionId: "sess_test_1", configId: "_agentMap", value: row.value },
  });
  await until((m) => m.id === 7, "the click's answer");
  const reply = seen.find((m) => m.id === 7);
  assert.ok(mapIn(reply), "answered with the full set");
  assert.equal(mapIn(reply).currentValue, "summary", "the click doesn't change what the row shows");
  await until((m, i) => seen.indexOf(m) > seenBefore && m.params?.update?.sessionUpdate === "config_option_update", "a republish after the click");

  for (let i = 0; i < 100 && !existsSync(launches); i += 1) await pause(50);
  const opened = readFileSync(launches, "utf8").trim().split("\n");
  assert.equal(opened.length, 1, "one click opens one log");
  const [flag, file] = JSON.parse(opened[0]);
  assert.equal(flag, "--existing", "in the window already open");
  assert.match(readFileSync(file, "utf8"), /^# Review the change/);
  assert.match(readFileSync(file, "utf8"), /Review this diff\./);

  // Clicking the summary, or a value from another thread, opens nothing.
  for (const [id, value] of [[8, "summary"], [9, "agent:not-here"]]) {
    send({
      jsonrpc: "2.0",
      id,
      method: "session/set_config_option",
      params: { sessionId: "sess_test_1", configId: "_agentMap", value },
    });
    await until((m) => m.id === id, "the answer");
  }
  await pause(300);
  assert.equal(readFileSync(launches, "utf8").trim().split("\n").length, 1, "still only the one log");
  assert.ok(!seen.some((m) => m.method === "test/leaked"), "clicks never reach the agent");
});

await throughProxy(
  { ZED_AGENT_USAGE_FAKE_AGENTS_DIR: threadDir, ZED_AGENT_USAGE_AGENT_MAP: "off" },
  async ({ seen, until }) => {
    await until((m) => m.id === 2, "the session");
    await pause(500);
    assert.ok(!seen.some(mapIn), "off removes it");
  },
);

// Zed's tool missing must not take the relay down with it.
await throughProxy(
  { ZED_AGENT_USAGE_FAKE_AGENTS_DIR: threadDir, ZED_AGENT_USAGE_ZED_COMMAND: path.join(scratch, "no-such-zed") },
  async ({ seen, send, until }) => {
    await until((m) => mapIn(m), "the item to appear");
    const row = lastMap(seen).options[1];
    const click = (id, value) =>
      send({
        jsonrpc: "2.0",
        id,
        method: "session/set_config_option",
        params: { sessionId: "sess_test_1", configId: "_agentMap", value },
      });
    click(20, row.value);
    await until((m) => m.id === 20, "the click's answer");
    await pause(500);
    click(21, "summary");
    await until((m) => m.id === 21, "an answer after the failed launch");
  },
);

// Idle stops the refreshes, as it does for usage, but a turn that runs for longer
// than the idle limit is not idle: that's when subagents are working.
const idleDir = path.join(scratch, "idle");
const lateAgent = (id) =>
  writeAgent(idleDir, id, {
    meta: { description: `Agent ${id}` },
    lines: [{ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "Go." } }],
    modifiedAt: Date.now(),
  });
const rowFor = (id) => (m) => mapIn(m)?.options.some((o) => o.name.includes(`Agent ${id}`));
lateAgent("early");
await throughProxy(
  {
    ZED_AGENT_USAGE_FAKE_AGENTS_DIR: idleDir,
    ZED_AGENT_USAGE_IDLE_AFTER_MS: "1",
    ZED_AGENT_USAGE_FAKE_HOLD_PROMPT: "1",
  },
  async ({ seen, send, until }) => {
    await until(rowFor("early"), "the map at thread start");
    lateAgent("idle");
    await pause(500);
    assert.ok(!seen.some(rowFor("idle")), "idle: logs are left alone");
    send({ jsonrpc: "2.0", id: 30, method: "session/prompt", params: { sessionId: "sess_test_1", prompt: [] } });
    await until(rowFor("idle"), "a turn to wake the map");
    await pause(300);
    lateAgent("deep");
    await until(rowFor("deep"), "the map to keep moving through a long turn");
  },
);

await throughProxy({}, async ({ seen, until }) => {
  await until((m) => m.id === 2, "the session");
  await pause(500);
  assert.ok(!seen.some(mapIn), "a provider with no subagent logs has no item");
});

// ---------------------------------------------------------------- finding the logs

const configDir = path.join(scratch, "claude-config");
const wanted = path.join(configDir, "projects", "C--Somewhere", "abc-123", "subagents");
mkdirSync(wanted, { recursive: true });
mkdirSync(path.join(configDir, "projects", "C--Elsewhere", "other", "subagents"), { recursive: true });
process.env.CLAUDE_CONFIG_DIR = configDir;
const { default: claude } = await import("../providers/claude.mjs");
assert.equal(claude.agentLogDir("abc-123"), wanted, "found by session id, whichever project holds it");
assert.equal(claude.agentLogDir("no-such-session"), null);

console.log("PASS: the agent map lists a thread's subagents and opens their logs");
