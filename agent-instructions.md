# Setup instructions for an agent

You are setting up **zed-claude-extras**, an ACP proxy that adds plan usage, an
agent map and tidier tool cards to Claude threads in Zed's agent panel. Do the
following for the user.

## 1. Get the repo

If it is not already checked out, clone it somewhere sensible and `cd` in:

```sh
git clone https://github.com/M3rg1/zed-claude-extras.git
cd zed-claude-extras
```

There are no dependencies — do not run `npm install`.

## 2. Add the Zed agent entry

```sh
node setup.mjs            # shows what it will write, and where
node setup.mjs --write    # writes it, backing up settings.json first
```

`setup.mjs` resolves every path itself (settings location, Zed's node, the ACP
adapter), all of which differ per platform. **Do not hand-write paths** and do
not reformat `settings.json` — it is JSONC, and the writer preserves comments and
trailing commas.

If it reports the adapter as not installed, tell the user to open a `claude-acp`
thread in Zed once so Zed downloads it, then re-run.

## 3. Check it works

```sh
node usage.mjs
```

This prints the live percentages. It consumes no quota and touches no
credentials. If it errors, report the error rather than guessing.

## 4. Tell the user

- Pick **Claude + usage** in Zed's agent panel picker.
- The usage appears as an extra item in the selector row at the bottom of a
  thread, e.g. `Usage · 42m`. Clicking it lists each limit and when it resets.
- Their existing `claude-acp` entry is untouched and still works.
- The proxy is long-lived, so after any update to this repo the agent needs
  restarting (kill the `proxy.mjs` process, or restart Zed) before changes show.
