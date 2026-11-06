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
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "*Sent 23:41*\n\n" } },
}, "a line of its own, as text: Zed draws every card with an icon");
assert.equal(times.end({ id: 99, result: { stopReason: "end_turn" } }, T0), null, "a response to anything else");
const done = times.end({ id: 7, result: { stopReason: "end_turn" } }, T0 + 372_000);
assert.equal(done.sessionId, "s1");
assert.equal(done.update.sessionUpdate, "agent_message_chunk");
assert.equal(done.update.content.text, "\n\n*Done 23:47 · 6m 12s*", "on a line of its own after the reply");
assert.equal(times.end({ id: 7, result: { stopReason: "end_turn" } }, T0), null, "a turn ends once");

const endOf = (response) => {
  times.start(response.id, "s1", T0);
  return times.end(response, T0 + 4_000).update.content.text.trim();
};
assert.equal(endOf({ id: 8, result: { stopReason: "cancelled" } }), "*Stopped 23:41 · 4s*");
assert.equal(endOf({ id: 9, error: { code: -32603, message: "boom" } }), "*Failed 23:41 · 4s*");
assert.equal(endOf({ id: 10, result: { stopReason: "max_tokens" } }), "*Ended (max_tokens) 23:41 · 4s*");
assert.equal(endOf({ id: 11, result: {} }), "*Ended (no reason given) 23:41 · 4s*");

// ---------------------------------------------------------------- through the proxy

/** Sends one prompt through the proxy, and resolves to the cards and the text Zed got,
 *  in order, with "response" where the turn's response came. */
function runTurn(env) {
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
          child.kill();
          resolve(seen);
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  });
}

const shown = await runTurn({});
// The stand-in adapter says "working" as a thread opens, before any prompt.
const startAt = shown.findIndex((x) => /^\*Sent /.test(x.text ?? ""));
assert.ok(startAt >= 0, "a line at the start");
assert.ok(shown.slice(0, startAt).every((x) => x.text === "working"), "before all of the turn's output");
const first = shown[startAt];
const last = shown.at(-2);
assert.match(first.text, /^\*Sent \d.*\*\n\n$/, "the turn's first line");
assert.equal(first.sessionId, "sess_test_1");
assert.match(last.text, /^\n\n\*Done \d.* · \ds\*$/, "the last line before the turn ends");
assert.equal(last.sessionId, "sess_test_1");
assert.equal(shown.at(-1), "response");
const timeLines = (s) => s.filter((x) => /\*(Sent|Done) /.test(x.text ?? ""));
assert.equal(timeLines(shown).length, 2, "two lines a turn");

const without = await runTurn({ ZED_AGENT_USAGE_TURN_TIMES: "off" });
assert.equal(timeLines(without).length, 0, "off: no lines");

console.log("PASS: each turn's reply starts and ends with a line of its times");
