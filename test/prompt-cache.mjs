/** The usage item estimates how long a thread's prompt cache has left.
 *
 *    node test/prompt-cache.mjs */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheLabel, cacheTtlMs } from "../lib/prompt-cache.mjs";
import { launchArgv } from "./launch.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOUR = 3_600_000;
const FIVE_MINUTES = 300_000;

// ---------------------------------------------------------------- units

assert.equal(cacheTtlMs({}), HOUR, "a subscription defaults to an hour");
assert.equal(cacheTtlMs({ ANTHROPIC_API_KEY: "" }), HOUR, "a blank key means the subscription");
assert.equal(cacheTtlMs({ ANTHROPIC_API_KEY: "k" }), FIVE_MINUTES, "an API key defaults to 5 minutes");
assert.equal(cacheTtlMs({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }), HOUR);
assert.equal(cacheTtlMs({ CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" }), FIVE_MINUTES);
assert.equal(cacheTtlMs({ CLAUDE_CODE_PROMPT_CACHE_TTL: "2h" }), HOUR, "only known values count");

assert.equal(cacheLabel(undefined, HOUR, 0), "", "unknown until a turn has run here");
assert.equal(cacheLabel({ running: true, endedAt: 0 }, HOUR, HOUR * 5), "cache 60m", "full while running");
assert.equal(cacheLabel({ running: false, endedAt: 0 }, HOUR, 0), "cache 60m");
assert.equal(cacheLabel({ running: false, endedAt: 0 }, HOUR, 1), "cache 60m", "rounds up");
assert.equal(cacheLabel({ running: false, endedAt: 0 }, HOUR, 18 * 60_000), "cache 42m");
assert.equal(cacheLabel({ running: false, endedAt: 0 }, HOUR, HOUR), "cache cold", "out of time");
assert.equal(cacheLabel({ running: false, endedAt: 0 }, FIVE_MINUTES, FIVE_MINUTES + 1), "cache cold");

// ---------------------------------------------------------------- through the proxy

/** Sends one prompt, and returns every usage label Zed was given. */
function labelsAfterPrompt(env) {
  const [command, args] = launchArgv({ viaLauncher: false });
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      ZED_AGENT_USAGE_PROVIDER_PATH: path.join(here, "fake-provider.mjs"),
      ZED_AGENT_USAGE_CACHE: "off",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_PROMPT_CACHE_TTL: "",
      ...env,
    },
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const labels = [];
  const beforePrompt = [];
  let answered = false;

  return new Promise((resolve) => {
    const finish = () => {
      child.kill();
      resolve({ labels, beforePrompt });
    };
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) !== -1) {
        const msg = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (msg.id === 1) send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "." } });
        const options = msg.result?.configOptions ?? msg.params?.update?.configOptions;
        const usage = options?.find((o) => o.id === "_usage");
        const label = usage?.options[0].name;
        if (label) (answered ? labels : beforePrompt).push(label);
        if (msg.id === 2) {
          // Long enough for the first usage read, so the label holds both parts.
          setTimeout(() => {
            answered = true;
            send({
              jsonrpc: "2.0",
              id: 3,
              method: "session/prompt",
              params: { sessionId: msg.result.sessionId, prompt: [] },
            });
          }, 1_000);
        }
        if (msg.id === 3) setTimeout(finish, 500);
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  });
}

const subscription = await labelsAfterPrompt({});
assert.ok(
  subscription.beforePrompt.every((l) => !l.includes("cache")),
  `no estimate before a turn has run: ${JSON.stringify(subscription.beforePrompt)}`,
);
assert.equal(subscription.labels.at(-1), "5h 42% · wk 7% · cache 60m");

const api = await labelsAfterPrompt({ ANTHROPIC_API_KEY: "k" });
assert.equal(api.labels.at(-1), "5h 42% · wk 7% · cache 5m");

const noUsage = await labelsAfterPrompt({ ANTHROPIC_API_KEY: "k", ZED_AGENT_USAGE_FAKE_UNAVAILABLE: "1" });
assert.equal(noUsage.labels.at(-1), "cache 5m", "shown even without plan figures");

const off = await labelsAfterPrompt({ ZED_AGENT_USAGE_PROMPT_CACHE: "off" });
assert.ok(off.labels.every((l) => !l.includes("cache")), "off removes it");

console.log("PASS: the usage item estimates the prompt cache's time left");
