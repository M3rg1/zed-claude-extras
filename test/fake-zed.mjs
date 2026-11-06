/** Stands in for Zed's command-line tool: records each launch's arguments, one JSON
 *  array per line, so a test can see what would have been opened. */
import { appendFileSync } from "node:fs";

appendFileSync(process.env.ZED_AGENT_USAGE_FAKE_ZED_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
