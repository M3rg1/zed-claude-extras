# Providers

A provider tells the proxy which ACP adapter to wrap and where the usage numbers
come from. `claude.mjs` is the only one; the tests swap in `test/fake-provider.mjs`
through `ZED_AGENT_USAGE_PROVIDER_PATH`. `index.mjs` loads `--provider <id>` from
this directory, defaulting to `claude`.

## Interface

| Field | Notes |
| --- | --- |
| `id` | Must equal the filename minus `.mjs`; `[a-z0-9-]` only |
| `displayName` | Used in CLI output and the default agent name in `setup.mjs` |
| `resolveAdapter()` | `{command, args}`, absolute `command` |
| `fetchUsage()` | Resolves to `{available, planType, windows}`; must not consume quota |
| `windows[]` | `{label, name?, usedPercent, resetsAt}`, shortest first; `label` is short (`5h`, `wk`), `name` is what the dropdown calls it and defaults to `label` |
| `lastTurnAt(sessionId)` | Optional. Epoch ms of the session's last reply, or null; gives a reopened thread its cache estimate |
| `cacheId()` | Optional. Names the kind of billing, so threads billed differently don't share a snapshot; defaults to `id` |
| `agentLogDir(sessionId)` | Optional. The folder of a session's subagent logs, or null; without it there is no agent map |

`available: false` or an empty `windows` means no plan limits, as on API billing;
the usage item then shows the prompt cache only. `resetsAt` gives the countdown and
the reset time in the dropdown. A `fetchUsage()` that throws is logged and retried
on the next refresh; the relay keeps working.

`lib/resolve.mjs` finds what Zed has installed (`zedPaths()`, `zedGlob()`,
`firstExisting()`, `resolveNode()`, `resolveNodeAdapter()`) across the per-platform
support directories; on Windows those are under `%LOCALAPPDATA%`, not `homedir()`.
