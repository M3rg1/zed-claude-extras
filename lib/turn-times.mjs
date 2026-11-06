/** A line at the start of each turn's reply and one at its end, with the time and, at
 *  the end, how long the turn took: Zed shows no times on a thread's messages. Lines of
 *  text rather than cards, since Zed draws every card with an icon. Display only: the
 *  lines go to Zed, never to the agent. */

/** The end line's first word, by the turn's stop reason; others are named as they are. */
const ENDED = { end_turn: "Done", cancelled: "Stopped" };

/** `ms` as `12s`, `6m 12s` or `1h 3m`. */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Epoch ms `at` as the hour and minute, in the system's locale. */
export function formatClock(at) {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Text Zed adds to the agent's reply, in italics. */
function text(markdown) {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: markdown } };
}

/** Updates that are new output of a turn, as opposed to updates of what an earlier turn
 *  started, such as a background command's exit. */
const OUTPUT = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call"]);

export class TurnTimes {
  #clock;
  /** Request id -> { sessionId, startedAt } of a running prompt, or { sessionId, replay }
   *  of a session/load replaying a thread's history. */
  #requests = new Map();
  /** sessionId -> { startedAt } of a turn Claude started itself, with no prompt. */
  #own = new Map();

  /** `clock` formats epoch ms for a line. */
  constructor(clock = formatClock) {
    this.#clock = clock;
  }

  #line(word, at, startedAt) {
    const took = startedAt === undefined ? "" : ` · ${formatDuration(at - startedAt)}`;
    return text(`*${word} ${this.#clock(at)}${took}*`);
  }

  #busy(sessionId) {
    for (const request of this.#requests.values()) if (request.sessionId === sessionId) return true;
    return false;
  }

  /** The `session/update` params for the first line of a turn that prompt request
   *  `requestId` starts in `sessionId` at epoch ms `now`; the reply follows it after a
   *  blank line. The prompt takes over a turn Claude started itself. */
  start(requestId, sessionId, now) {
    this.#own.delete(sessionId);
    this.#requests.set(requestId, { sessionId, startedAt: now });
    const line = this.#line("Sent", now);
    return { sessionId, update: text(`${line.content.text}\n\n`) };
  }

  /** Notes that session/load request `requestId` replays `sessionId`'s history, which
   *  is no turn of Claude's own. */
  replay(requestId, sessionId) {
    this.#requests.set(requestId, { sessionId, replay: true });
  }

  /** The `session/update` params for the last line of the turn `response` ends at epoch
   *  ms `now`, after a blank line, or null when it answers no turn. */
  end(response, now) {
    const request = this.#requests.get(response?.id);
    if (!request) return null;
    this.#requests.delete(response.id);
    if (request.replay) return null;
    const reason = response.result?.stopReason;
    const word = "error" in response ? "Failed" : (ENDED[reason] ?? `Ended (${reason ?? "no reason given"})`);
    const line = this.#line(word, now, request.startedAt);
    return { sessionId: request.sessionId, update: text(`\n\n${line.content.text}`) };
  }

  /** The `session/update` params for the first line of a turn Claude starts itself, to
   *  go before `update`, or null. Such a turn, e.g. when a background task wakes Claude,
   *  has no prompt: it starts with its first output while no request of `sessionId` is
   *  open. A subagent's output is not one. */
  observe(sessionId, update, now) {
    if (!OUTPUT.has(update?.sessionUpdate) || update._meta?.claudeCode?.parentToolUseId) return null;
    if (this.#own.has(sessionId) || this.#busy(sessionId)) return null;
    this.#own.set(sessionId, { startedAt: now });
    const line = this.#line("Woke", now);
    return { sessionId, update: text(`${line.content.text}\n\n`) };
  }

  /** The `session/update` params for the last line of a turn Claude started itself, to
   *  go after `update`, or null. Every turn ends with its result: the one usage_update
   *  with a cost. */
  turnResult(sessionId, update, now) {
    if (update?.sessionUpdate !== "usage_update" || !update.cost) return null;
    const own = this.#own.get(sessionId);
    if (!own) return null;
    this.#own.delete(sessionId);
    const line = this.#line("Done", now, own.startedAt);
    return { sessionId, update: text(`\n\n${line.content.text}`) };
  }
}
