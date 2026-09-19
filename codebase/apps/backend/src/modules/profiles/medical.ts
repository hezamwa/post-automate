import type { Profile } from "@post-automate/shared";

// Medical guardrails (FR-6.6–6.8, FR-7.2; spec §5.2): a profile with a compliance block
// can never be auto-published — the reviewer is the compliance check. Enforced in the
// API regardless of who asks, and re-checked by the job.

export function hasMedicalGuardrails(profile: Pick<Profile, "domain" | "compliance">): boolean {
  return profile.domain.field === "medical" || profile.compliance != null;
}
