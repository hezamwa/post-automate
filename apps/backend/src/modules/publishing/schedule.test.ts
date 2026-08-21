import { describe, expect, it } from "vitest";
import { techProfile } from "../../../test/fixtures";
import { computeNextSlot } from "./schedule";

// FR-7.5: publish at the next preferred slot. All arithmetic is UTC — a slot that
// drifts by a timezone offset publishes at the wrong hour for the reader.
const at = (iso: string) => new Date(iso);

describe("computeNextSlot (FR-7.5)", () => {
  const profile = techProfile(); // mon+thu, 09:00 UTC

  it("returns the next preferred day at the preferred hour", () => {
    // Tuesday 2026-08-18 → next preferred day is Thursday the 20th
    expect(computeNextSlot(profile, at("2026-08-18T12:00:00Z")).toISOString()).toBe(
      "2026-08-20T09:00:00.000Z",
    );
  });

  it("uses today when the preferred hour is still ahead", () => {
    // Monday 08:00 → today's 09:00 slot has not passed
    expect(computeNextSlot(profile, at("2026-08-17T08:00:00Z")).toISOString()).toBe(
      "2026-08-17T09:00:00.000Z",
    );
  });

  it("skips today once the preferred hour has passed", () => {
    // Monday 09:00 exactly — `candidate <= from` must not return the current instant
    expect(computeNextSlot(profile, at("2026-08-17T09:00:00Z")).toISOString()).toBe(
      "2026-08-20T09:00:00.000Z",
    );
  });

  it("wraps into the following week from the last preferred day", () => {
    // Thursday 10:00 → next is Monday the 24th
    expect(computeNextSlot(profile, at("2026-08-20T10:00:00Z")).toISOString()).toBe(
      "2026-08-24T09:00:00.000Z",
    );
  });

  it("treats an empty preferredDays list as 'any day'", () => {
    const anyDay = techProfile({
      cadence: { postsPerWeek: 7, preferredDays: [], preferredHourUtc: 9 },
    });
    expect(computeNextSlot(anyDay, at("2026-08-18T12:00:00Z")).toISOString()).toBe(
      "2026-08-19T09:00:00.000Z",
    );
  });

  it("crosses a month boundary without drifting", () => {
    // Monday 2026-08-31 12:00 → next preferred is Thursday 2026-09-03
    expect(computeNextSlot(profile, at("2026-08-31T12:00:00Z")).toISOString()).toBe(
      "2026-09-03T09:00:00.000Z",
    );
  });

  it("always returns a slot strictly in the future", () => {
    const from = at("2026-08-17T09:00:00Z");
    expect(computeNextSlot(profile, from).getTime()).toBeGreaterThan(from.getTime());
  });
});
