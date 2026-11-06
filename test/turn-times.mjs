/** A card at the start and the end of each turn, with the time and how long it took.
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
  update: { sessionUpdate: "tool_call", toolCallId: "_turn_1_start", title: "Sent 23:41", kind: "other", status: "completed" },
});
assert.equal(times.end({ id: 99, result: { stopReason: "end_turn" } }, T0), null, "a response to anything else");
const done = times.end({ id: 7, result: { stopReason: "end_turn" } }, T0 + 372_000);
assert.equal(done.sessionId, "s1");
assert.equal(done.update.toolCallId, "_turn_1_end");
assert.equal(done.update.title, "Done 23:47 · 6m 12s");
assert.equal(times.end({ id: 7, result: { stopReason: "end_turn" } }, T0), null, "a turn ends once");

const endOf = (response) => {
  times.start(response.id, "s1", T0);
  return times.end(response, T0 + 4_000).update.title;
};
assert.equal(endOf({ id: 8, result: { stopReason: "cancelled" } }), "Stopped 23:41 · 4s");
assert.equal(endOf({ id: 9, error: { code: -32603, message: "boom" } }), "Failed 23:41 · 4s");
assert.equal(endOf({ id: 10, result: { stopReason: "max_tokens" } }), "Ended (max_tokens) 23:41 · 4s");
assert.equal(endOf({ id: 11, result: {} }), "Ended (no reason given) 23:41 · 4s");

const ids = [times.start(12, "s1", T0), times.start(13, "s2", T0)].map((s) => s.update.toolCallId);
assert.notEqual(ids[0], ids[1], "each turn has its own cards");

// ---------------------------------------------------------------- through the proxy

/** Sends one prompt through the proxy, and resolves to the cards Zed got, in order,
 *  with "response" where the turn's response came. */
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
        if (update?.sessionUpdate === "tool_call") seen.push({ sessionId: msg.params.sessionId, ...update });
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

const cards = await runTurn({});
const first = cards[0];
const last = cards.at(-2);
assert.match(first.title, /^Sent \d/, "the first card of the turn");
assert.equal(first.sessionId, "sess_test_1");
assert.match(last.title, /^Done \d.* · \ds$/, "the last card before the turn ends");
assert.equal(last.sessionId, "sess_test_1");
assert.equal(cards.at(-1), "response");
assert.equal(cards.filter((c) => c.toolCallId?.startsWith("_turn_")).length, 2, "two cards a turn");

const without = await runTurn({ ZED_AGENT_USAGE_TURN_TIMES: "off" });
assert.ok(!without.some((c) => c.toolCallId?.startsWith("_turn_")), "off: no cards");

console.log("PASS: each turn gets a card at its start and its end");
