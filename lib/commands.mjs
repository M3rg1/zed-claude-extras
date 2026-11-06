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

/** `title` if it fits in `max` characters, else its text on one line, cut to fit
 *  and ending in "…". */
export function shortenCommand(title, max) {
  if (Array.from(title).length <= max) return title;
  const oneLine = title.replace(/\s+/g, " ").trim();
  const chars = Array.from(oneLine);
  if (chars.length <= max) return oneLine;
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}
