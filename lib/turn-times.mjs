/** A card when a turn starts and one when it ends, with the time and, at the end,
 *  how long the turn took: Zed shows no times on a thread's messages. Display only:
 *  the cards go to Zed, never to the agent. */

/** The end card's first word, by the turn's stop reason; others are named as they are. */
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

function card(toolCallId, title) {
  return { sessionUpdate: "tool_call", toolCallId, title, kind: "other", status: "completed" };
}

export class TurnTimes {
  #clock;
  /** Prompt request id -> { sessionId, cardId, startedAt } of a running turn. */
  #turns = new Map();
  #made = 0;

  /** `clock` formats epoch ms for a card. */
  constructor(clock = formatClock) {
    this.#clock = clock;
  }

  /** The `session/update` params for the card of a turn that prompt request
   *  `requestId` starts in `sessionId` at epoch ms `now`. */
  start(requestId, sessionId, now) {
    this.#made += 1;
    const cardId = `_turn_${this.#made}`;
    this.#turns.set(requestId, { sessionId, cardId, startedAt: now });
    return { sessionId, update: card(`${cardId}_start`, `Sent ${this.#clock(now)}`) };
  }

  /** The `session/update` params for the card of the turn `response` ends at epoch
   *  ms `now`, or null when it answers no turn. */
  end(response, now) {
    const turn = this.#turns.get(response?.id);
    if (!turn) return null;
    this.#turns.delete(response.id);
    const reason = response.result?.stopReason;
    const word = "error" in response ? "Failed" : (ENDED[reason] ?? `Ended (${reason ?? "no reason given"})`);
    const title = `${word} ${this.#clock(now)} · ${formatDuration(now - turn.startedAt)}`;
    return { sessionId: turn.sessionId, update: card(`${turn.cardId}_end`, title) };
  }
}
