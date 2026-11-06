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

export class TurnTimes {
  #clock;
  /** Prompt request id -> { sessionId, startedAt } of a running turn. */
  #turns = new Map();

  /** `clock` formats epoch ms for a line. */
  constructor(clock = formatClock) {
    this.#clock = clock;
  }

  /** The `session/update` params for the first line of a turn that prompt request
   *  `requestId` starts in `sessionId` at epoch ms `now`; the reply follows it after a
   *  blank line. */
  start(requestId, sessionId, now) {
    this.#turns.set(requestId, { sessionId, startedAt: now });
    return { sessionId, update: text(`*Sent ${this.#clock(now)}*\n\n`) };
  }

  /** The `session/update` params for the last line of the turn `response` ends at epoch
   *  ms `now`, after a blank line, or null when it answers no turn. */
  end(response, now) {
    const turn = this.#turns.get(response?.id);
    if (!turn) return null;
    this.#turns.delete(response.id);
    const reason = response.result?.stopReason;
    const word = "error" in response ? "Failed" : (ENDED[reason] ?? `Ended (${reason ?? "no reason given"})`);
    return {
      sessionId: turn.sessionId,
      update: text(`\n\n*${word} ${this.#clock(now)} · ${formatDuration(now - turn.startedAt)}*`),
    };
  }
}
