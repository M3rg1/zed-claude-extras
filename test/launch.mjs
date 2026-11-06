/** How the tests start the proxy.
 *
 *  Two shapes matter: `node proxy.mjs ...` (what the code under test is), and
 *  whatever settings.json actually points Zed at (what users get). The second is
 *  platform-specific -- on Windows the launcher is a .cmd, which is not
 *  universally spawnable, so it goes through cmd.exe just as `setup.mjs` writes
 *  it -- so it is worth exercising rather than assuming.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";

export const proxyPath = path.join(here, "..", "proxy.mjs");
export const launcherPath = path.join(
  here,
  "..",
  "bin",
  isWindows ? "zed-claude-extras.cmd" : "zed-claude-extras",
);

/** The environment to start a proxy with: this one, minus the plugin's own settings.
 *  A test run from an agent in Zed inherits that agent's `env` block, which would
 *  change what the proxy shows. */
export function testEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ZED_AGENT_USAGE_")));
}

/** `[command, args]` for spawning the proxy, with `extra` appended. */
export function launchArgv({ viaLauncher, extra = [] }) {
  if (!viaLauncher) return [process.execPath, [proxyPath, ...extra]];
  if (isWindows) {
    const cmdExe = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "cmd.exe");
    return [cmdExe, ["/c", launcherPath, ...extra]];
  }
  return [launcherPath, extra];
}
