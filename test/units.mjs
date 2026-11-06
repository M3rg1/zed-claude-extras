/** Unit tests for the tests' environment and the shared cache. */
import assert from "node:assert/strict";
import { acquireFetchLock, readCache, waitForCache, writeCache } from "../lib/cache.mjs";
import { testEnv } from "./launch.mjs";

// --- the tests' own environment ---------------------------------------------
// Tests run from an agent in Zed inherit that agent's settings, which would change
// what the proxy shows.
process.env.ZED_AGENT_USAGE_MARKER = "off";
process.env.UNRELATED_TO_THE_PROXY = "kept";
assert.equal(testEnv().ZED_AGENT_USAGE_MARKER, undefined, "the plugin's own settings stay out");
assert.equal(testEnv().UNRELATED_TO_THE_PROXY, "kept", "everything else is passed on");
delete process.env.ZED_AGENT_USAGE_MARKER;
delete process.env.UNRELATED_TO_THE_PROXY;

// --- cache ----------------------------------------------------------------
const id = `test-${process.pid}`;
const snapshot = { fetchedAt: Date.now(), usage: { available: true, windows: [] } };

assert.equal(readCache(id, 60_000), null, "nothing cached yet");

writeCache(id, snapshot);
assert.deepEqual(readCache(id, 60_000)?.usage, snapshot.usage, "round-trips within the TTL");
assert.equal(readCache(id, 0), null, "expired by a zero TTL");

writeCache(id, { fetchedAt: Date.now() - 120_000, usage: { windows: [] } });
assert.equal(readCache(id, 60_000), null, "too old to reuse");

writeCache(id, { nonsense: true });
assert.equal(readCache(id, 60_000), null, "wrong shape reads as a miss");

// --- single-flight lock ---------------------------------------------------
// Without this, proxies started together all miss the cache and all fetch.
const lockId = `lock-${process.pid}`;
const first = acquireFetchLock(lockId);
assert.ok(first, "the first caller wins");
assert.equal(acquireFetchLock(lockId), null, "a second caller is turned away");
first();
const third = acquireFetchLock(lockId);
assert.ok(third, "released, so the next caller wins");
third();
// A holder that dies mid-fetch must not block everyone forever.
assert.ok(acquireFetchLock(lockId), "acquired for the staleness check");
// Far below zero, as a new file's time can run ahead of the clock on Windows.
assert.ok(acquireFetchLock(lockId, -60_000), "a stale lock is taken over");
acquireFetchLock(lockId, -60_000)?.();

// A loser gets whatever the winner published.
writeCache(lockId, { fetchedAt: Date.now(), usage: { available: true, windows: [] } });
assert.ok(await waitForCache(lockId, 60_000, 1_000), "published snapshot is visible");
assert.equal(await waitForCache(`missing-${process.pid}`, 60_000, 300), null, "times out cleanly");

console.log("PASS: test environment and shared cache");
