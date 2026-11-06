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

/** Stands one card in for each unbroken run of a session's shell commands. Zed can't
 *  move a card, so the next command after anything else starts a new one, keeping
 *  the latest at the bottom. Display only: the agent still runs them, and a command
 *  awaiting approval keeps its own card. */
export class CommandSummary {
  #max;
  /** toolCallId -> latest command text. Kept for good, because a command's later
   *  reports name only its id and a stray one would reach Zed. */
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

    const known = this.#hidden.has(id);
    if (!known && update.kind !== "execute") return update;
    const titleChanged = typeof update.title === "string" && update.title !== this.#hidden.get(id);
    if (titleChanged) this.#hidden.set(id, update.title);
    if (!known) return this.#countCommand(sessionId, update.title);
    return titleChanged ? this.#retitle(sessionId, update.title) : null;
  }

  /** The tool call for an approval request. Zed draws a card it hasn't seen only
   *  from a title and kind, and the title stays whole so nothing is approved
   *  unread. Later reports of the command then reach its card. */
  approve(toolCall) {
    const id = toolCall.toolCallId;
    if (this.#hidden.has(id) || toolCall.kind === "execute") this.#approved.add(id);
    if (!this.#hidden.has(id)) return toolCall;
    return { kind: "execute", title: this.#hidden.get(id), ...toolCall };
  }

  /** Whether `update` puts something below the session's open card, which finishes
   *  it. Thoughts don't count: Claude thinks between most commands, so they would
   *  bring back nearly a card per command. */
  endsCard(update) {
    if (update.sessionUpdate === "agent_message_chunk") return true;
    if (update.sessionUpdate === "user_message_chunk") return true;
    if (update.sessionUpdate !== "tool_call") return false;
    return update.kind !== "execute" || this.#approved.has(update.toolCallId);
  }

  /** Closes the session's open card, returning the update that says so, or null
   *  if it has none. */
  finishCard(sessionId) {
    const card = this.#cards.get(sessionId);
    if (!card) return null;
    this.#cards.delete(sessionId);
    return { ...this.#cardUpdate(card), status: "completed" };
  }

  #countCommand(sessionId, command) {
    let card = this.#cards.get(sessionId);
    if (card) {
      card.count += 1;
      card.last = command;
      return this.#cardUpdate(card);
    }
    this.#cardsMade += 1;
    card = { id: `_commands_${this.#cardsMade}`, count: 1, last: command };
    this.#cards.set(sessionId, card);
    return {
      ...this.#cardUpdate(card),
      sessionUpdate: "tool_call",
      kind: "other",
      status: "in_progress",
    };
  }

  #retitle(sessionId, command) {
    const card = this.#cards.get(sessionId);
    if (!card) return null;
    card.last = command;
    return this.#cardUpdate(card);
  }

  #cardUpdate(card) {
    const noun = card.count === 1 ? "command" : "commands";
    const last = shortenCommand(card.last ?? "", this.#max ?? DEFAULT_MAX_CHARS).replace(/\s+/g, " ");
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: card.id,
      title: `Ran ${card.count} ${noun} · last: ${last}`,
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
