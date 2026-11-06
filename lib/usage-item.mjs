/** The usage item: a short word in the selector row, so it stays the same size however
 *  many limits a plan has, with each limit and the prompt cache in its dropdown. */

import { countdownLabel, describeWindows, localResetTime, maxUsedPercent, msUntil } from "./windows.mjs";

const SUMMARY_VALUE = "current";

function limitRow(window, index, now) {
  const text = `${window.name ?? window.label}: ${Math.round(window.usedPercent)}%`;
  const remaining = msUntil(window.resetsAt, now);
  const value = `limit:${index}`;
  if (remaining == null) return { value, name: text };
  return {
    value,
    name: `${text} · resets in ${countdownLabel(remaining)}`,
    description: `Resets ${localResetTime(now + remaining)}`,
  };
}

function cacheRow(cacheLeft) {
  return {
    value: "cache",
    name: cacheLeft === "cold" ? "Prompt cache: cold" : `Prompt cache: ${cacheLeft} left`,
    description:
      cacheLeft === "cold"
        ? "An estimate. Your next message writes the conversation to the cache again, which costs more."
        : "An estimate, counted down from the end of the last turn.",
  };
}

function summaryLabel({ windows, cacheLeft, staleMinutes, marker, markerAt }) {
  // No plan limits, as on API billing, so "Usage" would promise figures that don't exist.
  if (!windows.length) return `cache ${cacheLeft}`;
  const warn = marker && maxUsedPercent(windows) > markerAt;
  const word = `${warn ? `${marker} ` : ""}Usage${staleMinutes == null ? "" : " ?"}`;
  return cacheLeft ? `${word} · ${cacheLeft}` : word;
}

/** The selector for this thread, or null with nothing to show. `windows` are the plan's
 *  limits, empty where none apply; `cacheLeft` is from `cacheLeft()`, "" when unknown;
 *  `staleMinutes` is the age of figures that have stopped refreshing, else null;
 *  `marker` is "" when turned off, and appears when any limit is above `markerAt`;
 *  `now` is epoch ms. No `category`, so Zed doesn't treat it as a model or mode picker. */
export function usageOption({ windows, cacheLeft, staleMinutes, marker, markerAt, now }) {
  const limits = windows.filter((w) => typeof w?.usedPercent === "number");
  if (!limits.length && !cacheLeft) return null;
  const detail = [
    describeWindows(limits, { now }),
    limits.length && staleMinutes != null ? `last read ${staleMinutes}m ago` : null,
    cacheLeft ? "cache time is an estimate" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: "_usage",
    name: "Usage",
    description: detail,
    type: "select",
    currentValue: SUMMARY_VALUE,
    options: [
      {
        value: SUMMARY_VALUE,
        name: summaryLabel({ windows: limits, cacheLeft, staleMinutes, marker, markerAt }),
        description: detail,
      },
      ...limits.map((w, i) => limitRow(w, i, now)),
      ...(cacheLeft ? [cacheRow(cacheLeft)] : []),
    ],
  };
}
