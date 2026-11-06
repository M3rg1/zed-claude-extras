/** Keeping subagents' work out of the thread. Zed draws a subagent's tool calls in
 *  the thread as if the main agent made them, so a few reviewers reading a long
 *  diff fill it. Display only: the subagents still do the work, their logs keep
 *  it, and the agent map opens them. */

/** The Agent/Task tool call that started the subagent `update` comes from, or
 *  null for the main agent's own. The Claude adapter stamps it on what a
 *  subagent reports. */
export function parentToolUseIdOf(update) {
  const id = update?._meta?.claudeCode?.parentToolUseId;
  return typeof id === "string" && id ? id : null;
}

export class SubagentFilter {
  /** toolCallId -> { title, kind } of a hidden call, for an approval request
   *  that names it later. Kept for good, because a call's later reports may lack
   *  the stamp, and a stray one would reach Zed. */
  #hidden = new Map();
  /** Calls Zed has already drawn: a later stamp mustn't strand their cards. */
  #shown = new Set();

  /** Whether Zed should not get `update`. */
  hides(update) {
    const id = update.toolCallId;
    if (id && this.#hidden.has(id)) {
      const call = this.#hidden.get(id);
      if (typeof update.title === "string") call.title = update.title;
      if (update.kind) call.kind = update.kind;
      return true;
    }
    if (id && this.#shown.has(id)) return false;
    if (parentToolUseIdOf(update) === null) {
      if (id) this.#shown.add(id);
      return false;
    }
    if (id) this.#hidden.set(id, { title: update.title, kind: update.kind });
    return true;
  }

  /** The tool call for an approval request. A subagent's request still reaches
   *  the user, so its call is drawn from then on; Zed draws a card it hasn't seen
   *  only from a title and kind, so those come from the hidden call's reports. */
  approve(toolCall) {
    const id = toolCall.toolCallId;
    const call = this.#hidden.get(id);
    this.#hidden.delete(id);
    this.#shown.add(id);
    if (!call) return toolCall;
    const known = Object.fromEntries(Object.entries(call).filter(([, v]) => v !== undefined));
    return { ...known, ...toolCall };
  }
}
