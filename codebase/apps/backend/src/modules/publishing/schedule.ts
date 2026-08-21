import type { Profile } from "@post-automate/shared";

const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Next preferred publish slot after `from` (FR-7.5): profile cadence days + hour, UTC. */
export function computeNextSlot(profile: Profile, from = new Date()): Date {
  const days = profile.cadence.preferredDays.map((d) => DAY_INDEX[d]!);
  const hour = profile.cadence.preferredHourUtc;
  for (let add = 0; add <= 7; add++) {
    const candidate = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + add, hour, 0, 0),
    );
    if (candidate <= from) continue;
    if (days.length === 0 || days.includes(candidate.getUTCDay())) return candidate;
  }
  return new Date(from.getTime() + 24 * 3600 * 1000);
}
