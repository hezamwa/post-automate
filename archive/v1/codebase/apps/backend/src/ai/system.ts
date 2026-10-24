import type { SystemBlock } from "./types";

// The system prompt travels as ordered blocks so a provider that supports prompt caching
// can put a breakpoint after the stable prefix (design §6 "Prompt composition"); providers
// that cache automatically, or not at all, just get the joined text.

export function systemText(system: string | SystemBlock[] | undefined): string {
  if (!system) return "";
  return typeof system === "string" ? system : system.map((b) => b.text).join("\n\n");
}

/** Blocks from a prompt's system array: the last non-empty block at or before the breakpoint carries the cache flag. */
export function systemBlocks(system: string[], cacheBreakpointAfter?: number): SystemBlock[] {
  const kept = system.map((text, i) => ({ text, index: i })).filter((b) => b.text);
  const at = cacheBreakpointAfter == null ? -1 : kept.reduce((last, b) => (b.index <= cacheBreakpointAfter ? b.index : last), -1);
  return kept.map((b) => ({ text: b.text, ...(b.index === at ? { cache: true } : {}) }));
}
