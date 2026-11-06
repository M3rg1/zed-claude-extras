# zed-claude-extras

ACP proxy that adds to Claude threads in Zed's agent panel:

- **Usage**: plan limits with reset countdowns, and the prompt cache's time left.
- **Last activity**: when the thread was last worked in, as a date and time.
- **Agent map**: the thread's subagents as a tree; each opens its log.
- **Command card**: one card per run of shell commands and lookups.
- **Hidden subagent work**: subagents' tool calls kept out of the thread.
- **Title prefix**: a per-agent prefix on thread titles.

## Setup

No dependencies; reuses the Claude adapter and node Zed has downloaded.

```sh
node setup.mjs            # dry run: what it writes, and where
node setup.mjs --write    # write it; backs up settings.json first
```

Then pick **Claude + usage** in the agent panel. An existing `claude-acp` entry is
left as it is.

For setup by a coding agent:
`https://raw.githubusercontent.com/M3rg1/zed-claude-extras/main/agent-instructions.md`

Settings are read at startup and the proxy is long-lived: restart the agent after
changing settings or updating this repo.

## How it works

```
Zed  <--stdio-->  proxy.mjs  <--stdio-->  claude-acp adapter
```

Zed extensions have no UI. The proxy appends its own entries (`_usage`,
`_lastActivity`, `_agentMap`; ACP reserves the `_` prefix) to the session's config
options, which Zed renders as selectors, answers `session/set_config_option` for
them itself, and passes everything else through.

Usage fetches (settings named without their `ZED_AGENT_USAGE_` prefix):

- Triggered by session start, turn start, turn end and window resets, not a clock.
- At most once per `MIN_AGE_MS`, machine-wide; at least once per `MAX_AGE_MS` while
  in use.
- None after `IDLE_AFTER_MS` without a turn; window resets still fire.
- The label is re-rendered from cache every `RENDER_MS`, for the countdown.
- Proxies (one per Zed window) share a snapshot file in the temp dir; a lock elects
  one to fetch.
- `session/load` responses omit the session id; the proxy maps them back to the
  request.
- Archived and closed threads are dropped.
- After `STALE_AFTER` failed reads in a row the label shows `?`, and the tooltip the
  data's age.

## Where the numbers come from

The Agent SDK's `get_usage` control request (the data behind `/usage`), run in a
subprocess that authenticates itself: no credentials handled, no model calls, no
quota used. Experimental upstream; isolated in `providers/claude.mjs`.

## Usage item

Click for every limit; hover a row for the exact reset time:

```
5-hour: 11% · resets in 4h
Weekly: 15% · resets in 3d
Fable: 9% · resets in 3d
Prompt cache: 42m left
```

With API billing there are no plan limits; the item shows the cache only, as
`cache 5m`.

**Warning marker.** Above `ZED_AGENT_USAGE_MARKER_AT` (default 90) percent on any
limit, per-model ones included, the label gets `ZED_AGENT_USAGE_MARKER` (default
🔴): `🔴 Usage · 42m`. ACP has no colour or severity field, hence an emoji. `0`
shows it always; `off` or `100` never. Out-of-range values are clamped, unparseable
ones fall back to 90. `ZED_AGENT_USAGE_DEBUG=1` logs the threshold in effect.

**Prompt cache estimate.** `42m` or `cold`. A countdown from the end of the last
turn; for a reopened thread, from its transcript, and without one nothing until the
next turn. TTL: 1 hour on a subscription, 5 minutes with `ANTHROPIC_API_KEY`, or
`CLAUDE_CODE_PROMPT_CACHE_TTL`. Ignores the `promptCacheTtl` setting, compaction and
early eviction; main conversation only.

## Last activity

An item after Usage showing when the thread was last worked in, as `06 Nov, 23:28`
in the system's locale; Zed's thread list shows only a relative age (`9m`). Taken
from the turns the proxy relays and the `updatedAt` of Zed's thread list, so a
reopened thread has it. `ZED_AGENT_USAGE_LAST_ACTIVITY=off` removes it.

## Hiding selectors

`ZED_AGENT_USAGE_HIDE=agent,fast` drops the adapter's own selectors from the row.
Ids as of `claude-acp` 0.101: `mode`, `agent`, `model`, `effort`, `ultracode`,
`fast`. `ZED_AGENT_USAGE_DEBUG=1` logs them
(`config options:` in `dev: open acp logs`). A hidden selector can't be changed from
the panel: pin it in `default_config_options` first.

## Command card

Each unbroken run of shell commands and lookups (read, grep, glob) is one card:

```
Ran 18 commands, 6 lookups · last: sed -n 70,130p scripts/check-banned
```

- A message or another tool's card, such as an edit, ends the run; thoughts don't.
- Display only: the calls run and are logged as usual. Failed calls are folded in
  too. Read cards lose their file link. Calls awaiting approval keep their own card,
  with the whole command. The card always has the hammer icon.
- `ZED_AGENT_USAGE_COMMAND_SUMMARY=off`: one card per call again, command labels
  cut to `ZED_AGENT_USAGE_COMMAND_MAX` characters; the copy button copies the cut
  label.

## Hidden subagent work

Zed draws a subagent's tool calls as the main agent's. The proxy drops every update
the Claude adapter stamps with a parent tool call, except approval requests.
`ZED_AGENT_USAGE_HIDE_SUBAGENTS=off` shows them again. The agent map still opens
each subagent's log.

## Agent map

Appears once a thread has subagents, as `5 agents · 1 running`. Click
for the list: running first, then newest first, each subagent's own subagents
indented under it:

```
● Implement Task 6 · 15m · 225k
└ ● Summarize the… · 1m · 31k
 └ ○ Read AGENTS.md · 4s · 28k
○ Re-review round 1 · 3m · 132k
○ Fix round 1 · 4m · 298k
```

- `●` running, `○` done, `◌` unfinished with no log writes for 30 minutes
  (interrupted, or waiting on something long).
- Figures: time so far, and the last reply's size (context plus output).
- Titles are cut to fit Zed's row of about 34 characters; the indent comes out of
  the title, so only rows several levels deep overflow.
- Hover: full title, exact figures, type. Click: a readable copy of the log opens in
  Zed, long tool results cut, written to `ZED_AGENT_USAGE_CACHE_DIR`.

Read from Claude Code's subagent logs (`<session>/subagents/agent-*.jsonl` and
`.meta.json`) every `ZED_AGENT_USAGE_AGENT_MAP_MS` while the thread is in use. Claude
Code nests subagents at most three deep.

## Title prefix

Zed gives every custom agent the same icon, so the sidebar can't tell agents apart.
A per-agent title prefix can:

```json
"Claude + API":   { "env": { "ZED_AGENT_USAGE_TITLE_PREFIX": "🔑" } },
"Claude + usage": { "env": { "ZED_AGENT_USAGE_TITLE_PREFIX": "📊" } }
```

It goes on titles the agent sends: a new thread shows Zed's unprefixed preview
until its title arrives, an older thread gets it when reopened, and a thread renamed
by hand keeps its name.

## Config

Set in the agent entry's `env` block in `settings.json`.

| Env var | Default | Purpose |
| --- | --- | --- |
| `ZED_AGENT_USAGE_MARKER` | `🔴` | Warning glyph; `off` disables |
| `ZED_AGENT_USAGE_MARKER_AT` | `90` | Percentage (0-100) above which it appears |
| `ZED_AGENT_USAGE_MIN_AGE_MS` | `60000` | Floor: a real fetch happens at most this often, machine-wide |
| `ZED_AGENT_USAGE_MAX_AGE_MS` | `900000` | Ceiling: refresh anyway if nothing triggered for this long |
| `ZED_AGENT_USAGE_RENDER_MS` | `30000` | Re-render interval for the countdown |
| `ZED_AGENT_USAGE_CACHE` | on | `off` stops sharing snapshots between proxies |
| `ZED_AGENT_USAGE_STALE_AFTER` | `2` | Failed reads in a row before the label shows `?` |
| `ZED_AGENT_USAGE_IDLE_AFTER_MS` | `600000` | No turns for this long: stop refreshing |
| `ZED_AGENT_USAGE_HIDE` | – | Config-option ids to hide from the row |
| `ZED_AGENT_USAGE_LAST_ACTIVITY` | on | `off` removes the last-activity item |
| `ZED_AGENT_USAGE_PROMPT_CACHE` | on | `off` removes the prompt cache estimate |
| `ZED_AGENT_USAGE_COMMAND_SUMMARY` | on | `off` gives each shell command and lookup its own card again |
| `ZED_AGENT_USAGE_HIDE_SUBAGENTS` | on | `off` shows subagents' tool calls in the thread again |
| `ZED_AGENT_USAGE_COMMAND_MAX` | `80` | Longest command text shown, in characters; `off` leaves individual cards in full |
| `ZED_AGENT_USAGE_AGENT_MAP` | on | `off` removes the agent map |
| `ZED_AGENT_USAGE_AGENT_MAP_MS` | `15000` | How often the agent map checks for changes |
| `ZED_AGENT_USAGE_TITLE_PREFIX` | – | Text put in front of this agent's thread titles |
| `ZED_AGENT_USAGE_CACHE_DIR` | temp dir | Where the shared snapshot, activity record and subagent log copies live |
| `ZED_AGENT_USAGE_DEBUG` | – | `1` logs to stderr (`dev: open acp logs`) |
| `ZED_AGENT_USAGE_NODE` | auto | Node the launcher uses |
| `ZED_AGENT_USAGE_ADAPTER_COMMAND` / `_ARGS` | auto | Override the wrapped adapter |
| `ZED_AGENT_USAGE_ZED_COMMAND` / `_ARGS` | auto | Override Zed's command-line tool |
| `CLAUDE_AGENT_SDK` | auto | Override the Agent SDK binary |

## Layout

```
proxy.mjs                     ACP relay + the injected selectors
setup.mjs                     writes this machine's Zed settings entry
usage.mjs                     prints the usage snapshot
bin/zed-claude-extras[.cmd]   what Zed spawns; finds node at run time
providers/claude.mjs          the usage source and the Claude Code log paths
lib/windows.mjs               countdown labelling
lib/cache.mjs                 snapshot + activity record shared between proxies
lib/commands.mjs              the summary card and shortened command labels
lib/subagents.mjs             hiding subagents' work
lib/prompt-cache.mjs          the prompt cache estimate
lib/agent-map.mjs             the agent map and its readable logs
lib/usage-item.mjs            the usage item and its dropdown
lib/resolve.mjs               finding node and Zed's installed binaries
lib/jsonc.mjs                 comment-preserving settings.json edits
```

## Tests

```sh
npm test                  # unit, settings, and the proxy against a canned adapter
npm run usage             # live usage snapshot
npm run test:real         # against the real adapter, handshake only
```

## Notes

- Zed receives `_meta["_claude/rateLimit"]` from the Claude adapter but ignores it,
  and it has no percentage below a warning threshold.
- `~/.claude/projects/*.jsonl` has token counts, not plan-limit percentages.
- Zed discussion [#54792](https://github.com/zed-industries/zed/discussions/54792)
  asks for usage natively.

## License

[MIT](LICENSE). Forked from
[ortwinvanderstappen/zed-agent-usage](https://github.com/ortwinvanderstappen/zed-agent-usage).
Not affiliated with Anthropic or Zed Industries. Relies on
internal and experimental interfaces; may break on any upstream release.
