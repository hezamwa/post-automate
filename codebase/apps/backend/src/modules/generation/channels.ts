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

export const DECLINED_REASON = "Not selected at approval — the creator left this channel unticked (spec §4.3).";
