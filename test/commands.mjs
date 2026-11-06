/** Runs of shell commands and lookups collapse into one card each, long commands
 *  are shortened in the labels Zed shows, and subagents' work is hidden. Nothing
 *  else changes: not other tools' titles, not what the agent runs, and not the
 *  full call shown when the user is asked to approve it.
 *
 *    node test/commands.mjs */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommandMax, shortenCommand } from "../lib/commands.mjs";
import { launchArgv, testEnv } from "./launch.mjs";

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
      ...testEnv(),
      ZED_AGENT_USAGE_PROVIDER_PATH: path.join(here, "fake-provider.mjs"),
      ZED_AGENT_USAGE_CACHE: "off",
      ...env,
    },
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const seen = { updates: [], stream: [], texts: [], permissions: [], rawInputs: [] };
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
        if (update?.sessionUpdate?.endsWith("_chunk")) seen.texts.push(update.content?.text);
        if (update?.sessionUpdate?.endsWith("_chunk") && update.content?.text === "words") {
          seen.stream.push(update.sessionUpdate);
        }
        if (update?.toolCallId) {
          seen.stream.push(update);
          seen.updates.push(update);
          if (update.rawInput) seen.rawInputs.push(update.rawInput);
        }
        if (msg.method === "session/request_permission") seen.permissions.push(msg.params.toolCall);
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

// Summary on, the default: a card stands in for each unbroken run of commands and
// lookups.
const summary = await runPrompt({ ZED_AGENT_USAGE_COMMAND_MAX: "30" });
const ids = (seen) => new Set(seen.updates.map((u) => u.toolCallId));
for (const turn of [1, 2]) {
  for (const n of [1, 2, 4, 5]) {
    assert.ok(!ids(summary).has(`bash_${n}_${turn}`), "no card of its own, succeeded or failed");
  }
  assert.ok(!ids(summary).has(`grep_${turn}`), "nor a search");
  assert.ok(!ids(summary).has(`read_${turn}`), "nor a read");
}
const cardIds = [...ids(summary)].filter((id) => id.startsWith("_commands"));
assert.equal(cardIds.length, 6, "three runs in each of two turns");
const readLast = shortenCommand(`Read ${"long/".repeat(40)}`, 30);
const cardsRan = [
  `Ran 3 commands, 1 lookup · last: ${expected}`,
  `Ran 1 command, 1 lookup · last: ${readLast}`,
  `Ran 1 command · last: ${expected}`,
];
cardIds.forEach((id, i) => {
  const card = summary.updates.filter((u) => u.toolCallId === id);
  assert.equal(card.filter((u) => u.sessionUpdate === "tool_call").length, 1, "created once");
  assert.equal(card[0].sessionUpdate, "tool_call", "created before it is updated");
  assert.equal(card[0].kind, "other", "not drawn as a terminal");
  assert.equal(card[0].status, "in_progress", "running until something ends it");
  assert.equal(card[0].title, `Ran 1 command · last: ${expected}`);
  assert.equal(card.at(-1).status, "completed", "closed when it is finished");
  assert.equal(card.at(-1).title, cardsRan[i % 3]);
});
const firstCard = summary.updates.filter((u) => u.toolCallId === cardIds[0]).map((u) => u.title);
assert.ok(
  firstCard.includes('Ran 1 command, 1 lookup · last: grep "needle" src'),
  "a lookup's label is the last one while it is",
);

// Order in the thread: each card is finished before whatever comes after it.
const position = (match) => summary.stream.findIndex(match);
const lastOf = (id) => summary.stream.findLastIndex((e) => e.toolCallId === id);
const thought = position((e) => e === "agent_thought_chunk");
const message = position((e) => e === "agent_message_chunk");
const edit = position((e) => e.toolCallId === "edit_1");
const approval = position((e) => e.toolCallId === "bash_3_1");
assert.ok(lastOf(cardIds[0]) > thought, "a thought doesn't end a run of commands");
assert.ok(lastOf(cardIds[0]) < message, "a message does");
assert.ok(position((e) => e.toolCallId === cardIds[1]) > message, "the next command starts a card below it");
assert.ok(lastOf(cardIds[1]) < edit, "a tool that isn't a lookup ends a card too");
assert.ok(position((e) => e.toolCallId === cardIds[2]) > edit);
assert.ok(lastOf(cardIds[2]) < approval, "and so does a command awaiting approval");

assert.equal(titleOf(summary, "edit_1", "tool_call"), "Edit notes.txt", "other tools keep their cards");
const [commandApproval, subagentApproval] = summary.permissions;
assert.equal(commandApproval.title, LONG, "approval prompts show the whole command");
assert.equal(commandApproval.kind, "execute", "and Zed can draw the card");
assert.deepEqual(commandApproval.rawInput, { command: LONG }, "the agent's input is unchanged");
const approved = summary.updates.filter((u) => u.toolCallId === "bash_3_1");
assert.equal(approved.length, 1, "an approved command's card keeps getting its reports");
assert.equal(approved[0].status, "completed");
assert.equal(approved[0].title, expected, "and its label is shortened");

// Subagents' work stays out of the thread, but their approval requests don't.
for (const id of ["sub_bash_1", "sub_edit_1", "sub_bash_2", "sub_edit_2"]) {
  assert.ok(!ids(summary).has(id), `${id}: a subagent's call is hidden, even unstamped reports`);
}
assert.ok(!summary.texts.includes("subagent words"), "and so are its messages");
assert.equal(subagentApproval.title, "Read ../secret.txt", "a subagent's approval names the call");
assert.equal(subagentApproval.kind, "read", "and Zed can draw its card");
const subagentApproved = summary.updates.filter((u) => u.toolCallId === "sub_read_1");
assert.equal(subagentApproved.length, 1, "which then gets its reports");
assert.equal(subagentApproved[0].status, "completed");

// Summary off: every command and lookup gets its own card again.
const cards = await runPrompt({
  ZED_AGENT_USAGE_COMMAND_MAX: "30",
  ZED_AGENT_USAGE_COMMAND_SUMMARY: "off",
});
assert.equal(titleOf(cards, "bash_1_1", "tool_call"), expected, "first report of a command");
assert.equal(titleOf(cards, "bash_1_1", "tool_call_update"), expected, "a later report too");
assert.equal(titleOf(cards, "grep_1", "tool_call"), 'grep "needle" src', "a lookup");
assert.ok(![...ids(cards)].some((id) => id.startsWith("_commands")), "no summary card");
assert.deepEqual(cards.rawInputs[0], { command: LONG }, "what the agent runs is unchanged");
assert.ok(!ids(cards).has("sub_bash_1"), "subagents' work is still hidden");
assert.equal(cards.permissions[1].title, "Read ../secret.txt", "and their approvals still drawn");

const full = await runPrompt({
  ZED_AGENT_USAGE_COMMAND_MAX: "off",
  ZED_AGENT_USAGE_COMMAND_SUMMARY: "off",
  ZED_AGENT_USAGE_HIDE_SUBAGENTS: "off",
});
assert.equal(titleOf(full, "bash_1_1", "tool_call"), LONG, "both off keeps the whole command");
assert.ok(ids(full).has("sub_bash_1"), "subagents' calls show with hiding off");
assert.ok(ids(full).has("sub_edit_1"));
assert.ok(full.texts.includes("subagent words"), "and their messages");

console.log("PASS: runs of commands and lookups collapse into one card each, subagents' work is hidden");
