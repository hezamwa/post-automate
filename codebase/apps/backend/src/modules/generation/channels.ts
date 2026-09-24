import type { Profile } from "@post-automate/shared";

// Which derivatives a draft gets (spec §4.1 derivatives gate, §7): the profile says what
// is SUPPORTED; the approval says what was TICKED. Unsupported → absent (no row);
// supported but unticked → declined (a row, no call); ticked → run.

export type DerivativeKind = "x" | "linkedin" | "translation";
export const DERIVATIVE_KINDS: readonly DerivativeKind[] = ["x", "linkedin", "translation"];

export function supportedKinds(profile: Profile): DerivativeKind[] {
  const kinds: DerivativeKind[] = [...(profile.channels ?? ["x", "linkedin"])];
  if (profile.translation.enabled && profile.translation.targetLanguage) kinds.push("translation");
  return kinds;
}

/** The approved selection narrowed to what the profile supports; no selection = the profile decides. */
export function approvedKinds(profile: Profile, selection: readonly string[] | null | undefined): DerivativeKind[] {
  const supported = supportedKinds(profile);
  return selection == null ? supported : supported.filter((k) => selection.includes(k));
}

export function kindDecision(profile: Profile, selection: readonly string[] | null | undefined, kind: DerivativeKind): "absent" | "declined" | "run" {
  if (!supportedKinds(profile).includes(kind)) return "absent";
  return approvedKinds(profile, selection).includes(kind) ? "run" : "declined";
}

export const DECLINED_REASON = "Not selected — the creator left this unticked (spec §4.3).";

/**
 * FR-6.12: a channel text never exceeds its limit. The model is asked to shorten once; if
 * the answer is still long, it is trimmed at the last word boundary with "…" — a hard cap,
 * because X refuses an over-long post outright (403 for accounts without Premium).
 */
export function fitToLimit(text: string, max: number): string {
  const chars = [...text]; // code points, so Arabic and emoji are never split
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join("");
  const cut = head.lastIndexOf(" ");
  return `${(cut > max * 0.6 ? head.slice(0, cut) : head).trimEnd()}…`;
}
