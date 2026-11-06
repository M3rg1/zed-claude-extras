/** Long shell commands are shortened in the labels Zed shows, and nothing else
 *  changes: not other tools' titles, not what the agent runs, and not the full
 *  command shown when the user is asked to approve it.
 *
 *    node test/commands.mjs */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommandMax, shortenCommand } from "../lib/commands.mjs";
import { launchArgv } from "./launch.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- units

assert.equal(shortenCommand("git status", 20), "git status", "a short command is left alone");
assert.equal(shortenCommand("x".repeat(20), 20), "x".repeat(20), "exactly the limit still fits");
assert.equal(shortenCommand("x".repeat(21), 20), `${"x".repeat(19)}…`, "the result fits the limit");
assert.equal(shortenCommand("a  b\n  c d e f", 8), "a b c d…", "lines are joined before cutting");
assert.equal(shortenCommand("🔴".repeat(5), 3), "🔴🔴…", "emoji are not cut in half");
assert.equal(shortenCommand("one\ntwo", 20), "one\ntwo", "a short multi-line command is kept");

assert.equal(resolveCommandMax(undefined), 80, "default");
assert.equal(resolveCommandMax("120"), 120);
assert.equal(resolveCommandMax("off"), null, "off disables it");
assert.equal(resolveCommandMax("abc"), 80, "a typo falls back rather than disabling");
assert.equal(resolveCommandMax("-5"), 80);
assert.equal(resolveCommandMax("1.5"), 80);

// ---------------------------------------------------------------- through the proxy

const LONG = `echo ${"long ".repeat(40)}`;

/** Sends one prompt through the proxy and collects what reaches the client. */
function runPrompt(env) {
  const [command, args] = launchArgv({ viaLauncher: false });
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      ZED_AGENT_USAGE_PROVIDER_PATH: path.join(here, "fake-provider.mjs"),
      ZED_AGENT_USAGE_CACHE: "off",
      ...env,
    },
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const seen = { updates: [], permission: null, rawInputs: [] };
  let sessionId;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("no reply to the prompt within 15 s"));
    }, 15_000);
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) !== -1) {
        const msg = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (msg.id === 1) send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "." } });
        const prompt = (id, sessionId) =>
          send({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: [] } });
        if (msg.id === 2) {
          sessionId = msg.result.sessionId;
          prompt(3, sessionId);
        }
        const update = msg.params?.update;
        if (update?.toolCallId) {
          seen.updates.push(update);
          if (update.rawInput) seen.rawInputs.push(update.rawInput);
        }
        if (msg.method === "session/request_permission") seen.permission ??= msg.params.toolCall;
        if (msg.id === 3) prompt(4, sessionId);
        if (msg.id === 4) {
          clearTimeout(timeout);
          child.kill();
          resolve(seen);
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  });
}

const titleOf = (seen, toolCallId, sessionUpdate) =>
  seen.updates.find((u) => u.toolCallId === toolCallId && u.sessionUpdate === sessionUpdate)?.title;

const expected = shortenCommand(LONG, 30);

// Summary on, the default: one card a turn stands in for the turn's commands.
const summary = await runPrompt({ ZED_AGENT_USAGE_COMMAND_MAX: "30" });
const ids = (seen) => new Set(seen.updates.map((u) => u.toolCallId));
for (const hidden of ["bash_1_1", "bash_2_1", "bash_1_2", "bash_2_2"]) {
  assert.ok(!ids(summary).has(hidden), `${hidden} has no card, succeeded or failed`);
}
const cardIds = [...ids(summary)].filter((id) => id.startsWith("_commands"));
assert.equal(cardIds.length, 2, "one card a turn");
for (const id of cardIds) {
  const card = summary.updates.filter((u) => u.toolCallId === id);
  assert.equal(card.filter((u) => u.sessionUpdate === "tool_call").length, 1, "created once");
  assert.equal(card[0].sessionUpdate, "tool_call", "created before it is updated");
  assert.equal(card[0].kind, "other", "not drawn as a terminal");
  assert.equal(card[0].status, "in_progress", "running until the turn ends");
  assert.equal(card[0].title, `Ran 1 command · last: ${expected}`);
  assert.equal(card.at(-1).status, "completed", "closed when the turn ends");
  assert.equal(card.at(-1).title, `Ran 3 commands · last: ${expected}`);
}

assert.equal(titleOf(summary, "read_1", "tool_call"), `Read ${"long/".repeat(40)}`, "other tools");
assert.equal(summary.permission.title, LONG, "approval prompts show the whole command");
assert.equal(summary.permission.kind, "execute", "and Zed can draw the card");
assert.deepEqual(summary.permission.rawInput, { command: LONG }, "the agent's input is unchanged");
const approved = summary.updates.filter((u) => u.toolCallId === "bash_3_1");
assert.equal(approved.length, 1, "an approved command's card keeps getting its reports");
assert.equal(approved[0].status, "completed");
assert.equal(approved[0].title, expected, "and its label is shortened");

// Summary off: every command gets its own card again.
const cards = await runPrompt({
  ZED_AGENT_USAGE_COMMAND_MAX: "30",
  ZED_AGENT_USAGE_COMMAND_SUMMARY: "off",
});
assert.equal(titleOf(cards, "bash_1_1", "tool_call"), expected, "first report of a command");
assert.equal(titleOf(cards, "bash_1_1", "tool_call_update"), expected, "a later report too");
assert.ok(![...ids(cards)].some((id) => id.startsWith("_commands")), "no summary card");
assert.deepEqual(cards.rawInputs[0], { command: LONG }, "what the agent runs is unchanged");

const full = await runPrompt({
  ZED_AGENT_USAGE_COMMAND_MAX: "off",
  ZED_AGENT_USAGE_COMMAND_SUMMARY: "off",
});
assert.equal(titleOf(full, "bash_1_1", "tool_call"), LONG, "both off keeps the whole command");

console.log("PASS: commands collapse into one card a turn, in labels only");
