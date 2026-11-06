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
        if (msg.id === 2) {
          send({
            jsonrpc: "2.0",
            id: 3,
            method: "session/prompt",
            params: { sessionId: msg.result.sessionId, prompt: [] },
          });
        }
        const update = msg.params?.update;
        if (update?.toolCallId) {
          seen.updates.push(update);
          if (update.rawInput) seen.rawInputs.push(update.rawInput);
        }
        if (msg.method === "session/request_permission") seen.permission = msg.params.toolCall;
        if (msg.id === 3) {
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

const shortened = await runPrompt({ ZED_AGENT_USAGE_COMMAND_MAX: "30" });
const expected = shortenCommand(LONG, 30);
assert.equal(titleOf(shortened, "bash_1", "tool_call"), expected, "first report of a command");
assert.equal(titleOf(shortened, "bash_1", "tool_call_update"), expected, "a later report too");
assert.equal(titleOf(shortened, "read_1", "tool_call"), `Read ${"long/".repeat(40)}`, "other tools");
assert.equal(shortened.permission.title, LONG, "approval prompts show the whole command");
assert.deepEqual(shortened.rawInputs[0], { command: LONG }, "what the agent runs is unchanged");

const off = await runPrompt({ ZED_AGENT_USAGE_COMMAND_MAX: "off" });
assert.equal(titleOf(off, "bash_1", "tool_call"), LONG, "off keeps the whole command");

console.log("PASS: long commands are shortened in labels only");
