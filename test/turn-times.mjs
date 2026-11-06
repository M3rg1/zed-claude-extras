/** A line at the start and the end of each turn's reply, with the time and how long it took.
 *
 *    node test/turn-times.mjs */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatClock, formatDuration, TurnTimes } from "../lib/turn-times.mjs";
import { launchArgv, testEnv } from "./launch.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- units

assert.equal(formatDuration(0), "0s");
assert.equal(formatDuration(12_400), "12s");
assert.equal(formatDuration(372_000), "6m 12s");
assert.equal(formatDuration(3_780_000), "1h 3m");
assert.equal(formatDuration(-5), "0s", "a clock that steps back gives no negative time");
assert.match(formatClock(Date.parse("2026-11-06T23:41:00")), /23.41|11.41/, "the hour and minute");

const T0 = Date.parse("2026-11-06T23:41:00Z");
const clock = (at) => new Date(at).toISOString().slice(11, 16);
const times = new TurnTimes(clock);

const started = times.start(7, "s1", T0);
assert.deepEqual(started, {
  sessionId: "s1",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\n*Sent 23:41*\n\n" } },
}, "a line of its own, as text: Zed draws every card with an icon");
assert.equal(times.end({ id: 99, result: { stopReason: "end_turn" } }, T0), null, "a response to anything else");
const done = times.end({ id: 7, result: { stopReason: "end_turn" } }, T0 + 372_000);
assert.equal(done.sessionId, "s1");
assert.equal(done.update.sessionUpdate, "agent_message_chunk");
// Blank lines on both sides: Zed adds a turn Claude starts itself to the same message as
// the turn before, and two lines that touched would read "*Done …**Woke …*".
assert.equal(done.update.content.text, "\n\n*Done 23:47 · 6m 12s*\n\n", "on a line of its own after the reply");
assert.equal(times.end({ id: 7, result: { stopReason: "end_turn" } }, T0), null, "a turn ends once");

const endOf = (response) => {
  times.start(response.id, "s1", T0);
  return times.end(response, T0 + 4_000).update.content.text.trim();
};
assert.equal(endOf({ id: 8, result: { stopReason: "cancelled" } }), "*Stopped 23:41 · 4s*");
assert.equal(endOf({ id: 9, error: { code: -32603, message: "boom" } }), "*Failed 23:41 · 4s*");
assert.equal(endOf({ id: 10, result: { stopReason: "max_tokens" } }), "*Ended (max_tokens) 23:41 · 4s*");
assert.equal(endOf({ id: 11, result: {} }), "*Ended (no reason given) 23:41 · 4s*");

// A turn Claude starts itself, e.g. when a background task wakes it: no prompt, so its
// start is its first output and its end is its result, the one usage_update with a cost.
const own = new TurnTimes(clock);
const chunk = (text) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const result = { sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: 0.01, currency: "USD" } };
const lineOf = (params) => params?.update.content.text.trim() ?? null;

assert.equal(own.observe("s1", { sessionUpdate: "tool_call_update", toolCallId: "old" }, T0), null,
  "an update to an earlier call, like a background command's exit, starts nothing");
assert.equal(own.observe("s1", { sessionUpdate: "available_commands_update" }, T0), null);
assert.equal(own.turnResult("s1", result, T0), null, "no turn of its own to end");
const woke = own.observe("s1", chunk("woke"), T0);
assert.deepEqual(woke, { sessionId: "s1", update: chunk("\n\n*Woke 23:41*\n\n") }, "before its first output");
assert.equal(own.observe("s1", chunk("more"), T0), null, "once a turn");
assert.equal(own.observe("s2", { sessionUpdate: "tool_call", toolCallId: "t" }, T0) && "s2", "s2", "each thread");
assert.equal(own.turnResult("s1", { sessionUpdate: "usage_update", used: 1, size: 2 }, T0), null,
  "a usage update with no cost comes mid-turn");
assert.equal(lineOf(own.turnResult("s1", result, T0 + 9_000)), "*Done 23:41 · 9s*", "its result ends it");
assert.equal(own.turnResult("s1", result, T0), null, "and only once");
for (const kind of ["agent_thought_chunk", "tool_call"]) {
  const t = new TurnTimes(clock);
  assert.ok(t.observe("s1", { sessionUpdate: kind, toolCallId: "x" }, T0), `${kind} starts one too`);
}
const subagent = { ...chunk("hi"), _meta: { claudeCode: { parentToolUseId: "toolu_1" } } };
assert.equal(new TurnTimes(clock).observe("s1", subagent, T0), null, "a subagent's output is not Claude's turn");

const busy = new TurnTimes(clock);
busy.start(1, "s1", T0);
assert.equal(busy.observe("s1", chunk("reply"), T0), null, "output during your turn is your turn's");
assert.equal(busy.turnResult("s1", result, T0), null, "and so is its result");
busy.replay(2, "s3");
assert.equal(busy.observe("s3", chunk("old reply"), T0), null, "a reopened thread's replayed history");
assert.equal(busy.end({ id: 2, result: {} }, T0), null, "a replay has no end line");
assert.ok(busy.observe("s3", chunk("new"), T0), "after the replay, output is Claude's own again");
busy.start(3, "s3", T0);
assert.equal(lineOf(busy.end({ id: 3, result: { stopReason: "end_turn" } }, T0)), "*Done 23:41 · 0s*");
assert.equal(busy.turnResult("s3", result, T0), null, "your message takes over a turn Claude started itself");

// ---------------------------------------------------------------- through the proxy

/** Sends one prompt through the proxy, and resolves to the cards and the text Zed got,
 *  in order, with "response" where the turn's response came, `afterMs` after it. */
function runTurn(env, afterMs = 0) {
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
  const seen = [];
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
        if (update?.sessionUpdate === "tool_call") seen.push({ sessionId: msg.params.sessionId, card: update.title });
        if (update?.sessionUpdate === "agent_message_chunk") {
          seen.push({ sessionId: msg.params.sessionId, text: update.content?.text });
        }
        if (msg.id === 3) {
          seen.push("response");
          clearTimeout(timeout);
          setTimeout(() => {
            child.kill();
            resolve(seen);
          }, afterMs);
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  });
}

const shown = await runTurn({});
/** Text with its time and duration blanked, which depend on the clock. */
const blank = (x) => x.text.replace(/\d.*\*/, "…*");
// The stand-in adapter says "working" as a thread opens, before any prompt: to the proxy,
// a turn Claude started itself, and one that never reports its result.
const startAt = shown.findIndex((x) => /\*Sent /.test(x.text ?? ""));
assert.ok(startAt >= 0, "a line at the start");
assert.deepEqual(shown.slice(0, startAt).map(blank), ["\n\n*Woke …*\n\n", "working"], "Claude's own turn first");
const first = shown[startAt];
const last = shown.at(-2);
assert.match(first.text, /^\n\n\*Sent \d.*\*\n\n$/, "the turn's first line");
assert.equal(first.sessionId, "sess_test_1");
assert.match(last.text, /^\n\n\*Done \d.* · \ds\*\n\n$/, "the last line before the turn ends");
assert.equal(last.sessionId, "sess_test_1");
assert.equal(shown.at(-1), "response");
const timeLines = (s) => s.filter((x) => /\*(Sent|Done) /.test(x.text ?? ""));
assert.equal(timeLines(shown).length, 2, "two lines a turn");

// After the response, a background command wakes Claude: the command's exit, then the
// reply, with a line at each end.
const woken = await runTurn({ ZED_AGENT_USAGE_FAKE_WAKE: "1" }, 500);
const after = woken.slice(woken.indexOf("response") + 1).filter((x) => x.text !== undefined);
assert.deepEqual(after.map(blank), ["\n\n*Woke …*\n\n", "woke", "\n\n*Done …*\n\n"], "Claude's own turn");
assert.match(after[2].text, / · \ds\*\n\n$/, "with how long it took");

const without = await runTurn({ ZED_AGENT_USAGE_TURN_TIMES: "off", ZED_AGENT_USAGE_FAKE_WAKE: "1" }, 500);
assert.equal(without.filter((x) => /\*(Sent|Woke|Done) /.test(x.text ?? "")).length, 0, "off: no lines");

console.log("PASS: each turn's reply starts and ends with a line of its times");
