/** Shortening long shell commands in the labels Zed shows. Zed always draws a
 *  command in full, so a long one fills the thread however its output is folded.
 *  Display only: the agent keeps the real command. */

const DEFAULT_MAX_CHARS = 80;

/** The most characters a command label may have, or null when shortening is off.
 *  A value that is not a positive whole number falls back to the default, so a
 *  typo cannot quietly turn this off. */
export function resolveCommandMax(raw) {
  if (raw?.trim().toLowerCase() === "off") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_CHARS;
}

/** The tool kinds a summary card folds in: shell commands, and lookups (file reads,
 *  greps and globs), which come between commands so often that their cards would
 *  split nearly every run. Other tools, such as edits, keep their own cards. */
const FOLDED_KINDS = new Set(["execute", "read", "search"]);

/** Stands one card in for each unbroken run of a session's shell commands and
 *  lookups. Zed can't move a card, so the next one after anything else starts a new
 *  card, keeping the latest at the bottom. Display only: the agent still runs them,
 *  and a call awaiting approval keeps its own card. */
export class CommandSummary {
  #max;
  /** toolCallId -> { title, kind } of a folded call, title the latest. Kept for
   *  good, because a call's later reports name only its id and a stray one would
   *  reach Zed. */
  #hidden = new Map();
  #approved = new Set();
  /** sessionId -> the open card. */
  #cards = new Map();
  #cardsMade = 0;

  /** `max` is the longest command text to show; null leaves approved commands whole. */
  constructor(max) {
    this.#max = max;
  }

  /** What Zed should get in place of `update`: the update itself, a summary card
   *  update, or null for nothing. */
  filter(sessionId, update) {
    const id = update.toolCallId;
    if (!id) return update;
    if (this.#approved.has(id)) return this.#max === null ? update : shortenTitle(update, this.#max);

    const call = this.#hidden.get(id);
    if (!call && !FOLDED_KINDS.has(update.kind)) return update;
    const titleChanged = typeof update.title === "string" && update.title !== call?.title;
    if (!call) {
      this.#hidden.set(id, { title: update.title, kind: update.kind });
      return this.#countCall(sessionId, update.title, update.kind);
    }
    if (!titleChanged) return null;
    call.title = update.title;
    return this.#retitle(sessionId, update.title);
  }

  /** The tool call for an approval request. Zed draws a card it hasn't seen only
   *  from a title and kind, and the title stays whole so nothing is approved
   *  unread. Later reports of the call then reach its card. */
  approve(toolCall) {
    const id = toolCall.toolCallId;
    const call = this.#hidden.get(id);
    if (call || FOLDED_KINDS.has(toolCall.kind)) this.#approved.add(id);
    if (!call) return toolCall;
    return { kind: call.kind, title: call.title, ...toolCall };
  }

  /** Whether `update` puts something below the session's open card, which finishes
   *  it. Thoughts don't count: Claude thinks between most commands, so they would
   *  bring back nearly a card per command. */
  endsCard(update) {
    if (update.sessionUpdate === "agent_message_chunk") return true;
    if (update.sessionUpdate === "user_message_chunk") return true;
    if (update.sessionUpdate !== "tool_call") return false;
    return !FOLDED_KINDS.has(update.kind) || this.#approved.has(update.toolCallId);
  }

  /** Closes the session's open card, returning the update that says so, or null
   *  if it has none. */
  finishCard(sessionId) {
    const card = this.#cards.get(sessionId);
    if (!card) return null;
    this.#cards.delete(sessionId);
    return { ...this.#cardUpdate(card), status: "completed" };
  }

  #countCall(sessionId, title, kind) {
    const lookup = kind !== "execute";
    let card = this.#cards.get(sessionId);
    if (card) {
      if (lookup) card.lookups += 1;
      else card.commands += 1;
      card.last = title;
      return this.#cardUpdate(card);
    }
    this.#cardsMade += 1;
    card = {
      id: `_commands_${this.#cardsMade}`,
      commands: lookup ? 0 : 1,
      lookups: lookup ? 1 : 0,
      last: title,
    };
    this.#cards.set(sessionId, card);
    return {
      ...this.#cardUpdate(card),
      sessionUpdate: "tool_call",
      kind: "other",
      status: "in_progress",
    };
  }

  #retitle(sessionId, title) {
    const card = this.#cards.get(sessionId);
    if (!card) return null;
    card.last = title;
    return this.#cardUpdate(card);
  }

  #cardUpdate(card) {
    const counted = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
    const parts = [];
    if (card.commands > 0) parts.push(counted(card.commands, "command"));
    if (card.lookups > 0) parts.push(counted(card.lookups, "lookup"));
    const last = shortenCommand(card.last ?? "", this.#max ?? DEFAULT_MAX_CHARS).replace(/\s+/g, " ");
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: card.id,
      title: `Ran ${parts.join(", ")} · last: ${last}`,
    };
  }
}

/** `update` with its command label cut to `max` characters, if it has a label. */
export function shortenTitle(update, max) {
  if (typeof update.title !== "string") return update;
  return { ...update, title: shortenCommand(update.title, max) };
}

/** `title` if it fits in `max` characters, else its text on one line, cut to fit
 *  and ending in "…". */
export function shortenCommand(title, max) {
  if (Array.from(title).length <= max) return title;
  const oneLine = title.replace(/\s+/g, " ").trim();
  const chars = Array.from(oneLine);
  if (chars.length <= max) return oneLine;
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}
