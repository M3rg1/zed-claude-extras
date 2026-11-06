/** The agent map: a thread's subagents as one item in the selector row, read from
 *  the logs Claude Code writes for each of them. Clicking a row opens a readable
 *  copy of that subagent's log. */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { shortenCommand } from "./commands.mjs";

/** An unfinished subagent whose log hasn't moved for this long may have been
 *  interrupted: Claude Code never marks those finished. It may also just be waiting
 *  on a long command, so it reads as quiet rather than stopped. */
const QUIET_AFTER_MS = 30 * 60_000;
/** Zed's dropdown cuts a row at about 35 characters, depending on the letters, so a
 *  long row would lose its figures. The hover keeps the title and figures whole. */
const ROW_CHARS = 34;
const ROW_MARK_CHARS = 2;
/** A nested row starts with a branch, an em space further in for each level below
 *  the first: Zed's font is proportional, so plain spaces barely move a row. An em
 *  space is about as wide as two letters, so it counts as two. The indent comes out
 *  of the title's room, down to this much title, so a row only overflows several
 *  levels deep. */
const BRANCH = "└ ";
const LEVEL_INDENT = " ";
const LEVEL_INDENT_CHARS = 2;
const MIN_TITLE_CHARS = 8;
const FIGURE_SEPARATOR = " · ";
const TOOL_INPUT_CHARS = 300;
const TOOL_RESULT_CHARS = 2_000;

const SUMMARY_VALUE = "summary";
const VALUE_PREFIX = "agent:";
const STATUS_MARK = { running: "●", done: "○", quiet: "◌" };
const STATUS_NOTE = {
  running: "running",
  done: "done",
  quiet: "no log activity for over 30 minutes, so it may have stopped",
};

function formatSeconds(seconds) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTokens(tokens) {
  return tokens < 1_000 ? String(tokens) : `${(tokens / 1_000).toFixed(1)}k`;
}

/** The figures known so far, without any that are still zero. */
function figures(agent) {
  return [
    agent.seconds > 0 ? formatSeconds(agent.seconds) : null,
    agent.tokens > 0 ? formatTokens(agent.tokens) : null,
  ].filter(Boolean);
}

/** Non-empty parsed lines of a JSONL log. A subagent being written to can end in a
 *  half-written line, which is skipped rather than fatal. */
function parseLog(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* half-written */
    }
  }
  return entries;
}

/** Time from the first entry to the last, and the size of the last reply: what the
 *  model was given plus what it wrote, which is what VS Code's map shows. */
function summarizeLog(text) {
  let first = Infinity;
  let last = -Infinity;
  let usage = null;
  for (const entry of parseLog(text)) {
    const at = Date.parse(entry.timestamp);
    if (Number.isFinite(at)) {
      first = Math.min(first, at);
      last = Math.max(last, at);
    }
    usage = entry.message?.usage ?? usage;
  }
  const tokens = usage
    ? (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.output_tokens ?? 0)
    : 0;
  return {
    startedAt: Number.isFinite(first) ? first : 0,
    seconds: Number.isFinite(first) ? Math.round((last - first) / 1000) : 0,
    tokens,
  };
}

/** A file's metadata, or null once it has gone. */
async function statOrNull(file) {
  try {
    return await stat(file);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** The metadata beside a log, or {} when it's missing or being rewritten. */
async function readMeta(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT" || err instanceof SyntaxError) return {};
    throw err;
  }
}

function byRunningThenNewest(a, b) {
  const running = Number(b.status === "running") - Number(a.status === "running");
  return running || b.startedAt - a.startedAt;
}

/** Reads a thread's subagents. It holds on to what it has parsed, because a long
 *  thread has dozens of finished logs that would otherwise be parsed again on every
 *  refresh, on the thread that relays the agent's messages. */
export class AgentLogReader {
  /** folder -> id -> { stamp, parsed }; each read replaces its folder's entry, so
   *  deleted logs drop out. */
  #parsedByDir = new Map();

  /** The subagents in `dir`, running first and then newest first, each as
   *  `{ id, description, type, model, parentId, status, startedAt, seconds, tokens, logPath }`.
   *  `parentId` is the id of the subagent that started it, or null for the main
   *  agent. `status` is "running", "done" or "quiet". `now` is epoch ms. A missing folder
   *  means no subagents yet; other read failures throw. */
  async read(dir, now) {
    let names;
    try {
      names = await readdir(dir);
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    const known = this.#parsedByDir.get(dir) ?? new Map();
    const ids = names.filter((n) => n.startsWith("agent-") && n.endsWith(".jsonl")).map((n) => n.slice(6, -6));
    const read = await Promise.all(ids.map((id) => this.#readAgent(dir, id, known.get(id), now)));
    const found = read.filter(Boolean);
    this.#parsedByDir.set(dir, new Map(found.map((f) => [f.agent.id, f.parsed])));
    return found.map((f) => f.agent).sort(byRunningThenNewest);
  }

  async #readAgent(dir, id, known, now) {
    const logPath = path.join(dir, `agent-${id}.jsonl`);
    const metaPath = path.join(dir, `agent-${id}.meta.json`);
    const [log, metaStat] = await Promise.all([statOrNull(logPath), statOrNull(metaPath)]);
    if (!log) return null;
    const stamp = `${log.mtimeMs}:${log.size}:${metaStat?.mtimeMs}`;
    const parsed =
      known?.stamp === stamp
        ? known
        : { stamp, summary: summarizeLog(await readFile(logPath, "utf8")), meta: await readMeta(metaPath) };
    const { meta, summary } = parsed;
    const quiet = now - log.mtimeMs > QUIET_AFTER_MS;
    return {
      parsed,
      agent: {
        id,
        description: meta.description ?? id,
        type: meta.agentType ?? null,
        model: meta.model ?? null,
        parentId: typeof meta.parentAgentId === "string" && meta.parentAgentId ? meta.parentAgentId : null,
        status: meta.finished === true ? "done" : quiet ? "quiet" : "running",
        ...summary,
        logPath,
      },
    };
  }
}

/** The figures rounded to fit a row, at most about 11 characters: whole minutes, and
 *  whole thousands from 100k. */
function rowFigures(agent) {
  const time = agent.seconds < 60 ? `${agent.seconds}s` : `${Math.floor(agent.seconds / 60)}m`;
  const size = agent.tokens < 100_000 ? formatTokens(agent.tokens) : `${Math.round(agent.tokens / 1_000)}k`;
  return [agent.seconds > 0 ? time : null, agent.tokens > 0 ? size : null].filter(Boolean).join(FIGURE_SEPARATOR);
}

/** `agents` with each one's subagents right after it, at any depth, as
 *  `{ agent, depth }`. Siblings keep their order in `agents`. One whose parent isn't
 *  listed, or whose parents loop, goes at the top level rather than being lost. */
function inTreeOrder(agents) {
  const listed = new Set(agents.map((a) => a.id));
  const childrenOf = new Map();
  for (const agent of agents) {
    const parent = listed.has(agent.parentId) ? agent.parentId : null;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(agent);
  }
  const ordered = [];
  const placed = new Set();
  const place = (agent, depth) => {
    if (placed.has(agent.id)) return;
    placed.add(agent.id);
    ordered.push({ agent, depth });
    for (const child of childrenOf.get(agent.id) ?? []) place(child, depth + 1);
  };
  for (const root of childrenOf.get(null) ?? []) place(root, 0);
  for (const agent of agents) place(agent, 0); // only those whose parents loop are left
  return ordered;
}

function indentFor(depth) {
  return depth === 0 ? "" : `${LEVEL_INDENT.repeat(depth - 1)}${BRANCH}`;
}

/** How many letters' room the indent for `depth` takes. */
function indentChars(depth) {
  return depth === 0 ? 0 : (depth - 1) * LEVEL_INDENT_CHARS + BRANCH.length;
}

function agentRow(agent, depth) {
  const stats = rowFigures(agent);
  const indent = indentFor(depth);
  const room = Math.max(
    MIN_TITLE_CHARS,
    ROW_CHARS - indentChars(depth) - ROW_MARK_CHARS - (stats ? stats.length + FIGURE_SEPARATOR.length : 0),
  );
  const title = `${indent}${STATUS_MARK[agent.status]} ${shortenCommand(agent.description, room)}`;
  const details = [agent.type, agent.model, STATUS_NOTE[agent.status]];
  if (agent.seconds > 0) details.push(formatSeconds(agent.seconds));
  if (agent.tokens > 0) details.push(`${formatTokens(agent.tokens)} tokens`);
  return {
    value: `${VALUE_PREFIX}${agent.id}`,
    name: stats ? `${title}${FIGURE_SEPARATOR}${stats}` : title,
    description: `${agent.description}\n${details.filter(Boolean).join(" · ")}`,
  };
}

/** The selector for `agents`, or null with none to show. Its current value is always
 *  the summary, so the row in Zed reads as a count rather than as one agent. Zed draws
 *  only a flat list, so a subagent's subagents are indented under it. */
export function agentMapOption(agents) {
  if (!agents?.length) return null;
  const running = agents.filter((a) => a.status === "running").length;
  const count = `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`;
  return {
    id: "_agentMap",
    name: "Agents",
    description: "This thread's subagents. Pick one to open its log.",
    type: "select",
    currentValue: SUMMARY_VALUE,
    options: [
      { value: SUMMARY_VALUE, name: running ? `${count} · ${running} running` : count },
      ...inTreeOrder(agents).map(({ agent, depth }) => agentRow(agent, depth)),
    ],
  };
}

/** The agent a selector value stands for, or undefined for the summary row or a
 *  value that isn't one of `agents`. */
export function agentForValue(agents, value) {
  return agents?.find((a) => `${VALUE_PREFIX}${a.id}` === value);
}

function fenced(text) {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${text}\n${fence}`;
}

function cut(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n… cut, see the full log` : text;
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.text ?? "").join("\n");
}

function blockMarkdown(block) {
  if (block.type === "text") return block.text;
  if (block.type === "tool_use") {
    return `**${block.name}** \`${cut(JSON.stringify(block.input ?? {}), TOOL_INPUT_CHARS)}\``;
  }
  if (block.type === "tool_result") return fenced(cut(toolResultText(block.content), TOOL_RESULT_CHARS));
  return null; // thinking and anything unknown
}

/** A readable copy of a subagent's log `text`, with `agent` as its heading: its
 *  messages, its tool calls and the start of each tool result. */
export function agentLogMarkdown(agent, text) {
  const heading = [agent.type, agent.model, STATUS_NOTE[agent.status], ...figures(agent)].filter(Boolean);
  const parts = [`# ${agent.description}`, heading.join(" · "), `Full log: \`${agent.logPath}\``];
  for (const { message } of parseLog(text)) {
    if (!message) continue;
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    for (const block of blocks ?? []) {
      const shown = blockMarkdown(block);
      if (shown) parts.push(shown);
    }
  }
  return `${parts.join("\n\n")}\n`;
}
