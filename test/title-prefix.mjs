/** The thread-title prefix: what tells threads from different agent entries
 *  apart in Zed's sidebar, where two custom agents get the same generic icon.
 *
 *  Driven through the real proxy, with the fake adapter emitting each update. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testEnv } from "./launch.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION = "sess_test_1";
const PREFIX = "🔑";

/** Updates for the adapter to emit; `_meta.case` names each in the output. */
const CASES = [
  { sessionUpdate: "session_info_update", title: "Plain", updatedAt: "2026-11-06T10:00:00Z" },
  { sessionUpdate: "session_info_update", title: `${PREFIX} Already labelled` },
  { sessionUpdate: "session_info_update", title: null },
  { sessionUpdate: "session_info_update" },
  { sessionUpdate: "tool_call", toolCallId: "read_1", title: "Read a file", kind: "read" },
].map((update, i) => ({ ...update, _meta: { case: i } }));

/** Run one proxy until every case has come back, and return what Zed would see:
 *  the updates by case number, and the title the adapter generated itself. */
function run(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, "..", "proxy.mjs")], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...testEnv(),
        ZED_AGENT_USAGE_PROVIDER_PATH: path.join(here, "fake-provider.mjs"),
        ZED_AGENT_USAGE_CACHE: "off",
        ZED_AGENT_USAGE_LAST_ACTIVITY: "off",
        ...extraEnv,
      },
    });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const seen = new Map();
    let generated;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out; saw cases ${[...seen.keys()]}, generated ${generated}`));
    }, 15_000);

    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === 2) {
          for (const update of CASES) {
            send({
              jsonrpc: "2.0",
              method: "test/emit_update",
              params: { sessionId: SESSION, update },
            });
          }
        }
        const update = msg.params?.update;
        if (update?._meta?.case !== undefined) seen.set(update._meta.case, update);
        else if (update?.sessionUpdate === "session_info_update") generated = update.title;
        if (seen.size === CASES.length && generated !== undefined) {
          clearTimeout(timeout);
          child.kill();
          resolve({ seen, generated });
        }
      }
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd() } });
  });
}

// With a prefix.
const on = await run({ ZED_AGENT_USAGE_TITLE_PREFIX: PREFIX });
assert.equal(on.generated, "🔑 Fix auth bug", "the agent's generated title gets the prefix");
assert.equal(on.seen.get(0).title, "🔑 Plain");
assert.equal(on.seen.get(0).updatedAt, "2026-11-06T10:00:00Z", "other fields are kept");
assert.equal(on.seen.get(1).title, "🔑 Already labelled", "a title sent back is not doubled");
assert.equal(on.seen.get(2).title, null, "clearing the title still clears it");
assert.equal("title" in on.seen.get(3), false, "an update without a title must not gain one");
assert.equal(on.seen.get(4).title, "Read a file", "a tool call's title is not a thread title");

// A prefix with spaces around it reads the same.
const padded = await run({ ZED_AGENT_USAGE_TITLE_PREFIX: `  ${PREFIX} ` });
assert.equal(padded.generated, "🔑 Fix auth bug");

// No prefix: titles are relayed verbatim, whether it is unset or empty.
for (const env of [{}, { ZED_AGENT_USAGE_TITLE_PREFIX: "  " }]) {
  const off = await run(env);
  assert.equal(off.generated, "Fix auth bug");
  assert.equal(off.seen.get(0).title, "Plain");
}

console.log("PASS: thread titles carry the prefix once, and only thread titles do");
process.exit(0);
