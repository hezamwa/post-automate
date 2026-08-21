import { describe, expect, it } from "vitest";
import { crossedThresholds, projectMonthEndUsd } from "./budget";

describe("projectMonthEndUsd (FR-15.10, /admin/budget)", () => {
  it("projects linearly from month-to-date spend", () => {
    // $5 by the 10th of a 30-day month → $15 by month end
    expect(projectMonthEndUsd(5, new Date(Date.UTC(2026, 8, 10)))).toBeCloseTo(15, 10);
  });

  it("equals the spend itself on the last day of the month", () => {
    expect(projectMonthEndUsd(12, new Date(Date.UTC(2026, 8, 30)))).toBeCloseTo(12, 10);
  });

  it("handles day one without dividing by zero", () => {
    expect(projectMonthEndUsd(1, new Date(Date.UTC(2026, 0, 1)))).toBeCloseTo(31, 10);
  });
});

describe("crossedThresholds (FR-15.10/15.11 alert dedup)", () => {
  it("reports exactly the thresholds this call crossed", () => {
    expect(crossedThresholds(15.9, 0.2, 20)).toEqual([80]); // 15.9 → 16.1 crosses 80% of $20
    expect(crossedThresholds(19.9, 0.2, 20)).toEqual([100]);
    expect(crossedThresholds(15, 6, 20)).toEqual([80, 100]); // one big call crosses both
  });

  it("stays silent while already above a line — no repeat pushes", () => {
    expect(crossedThresholds(16.5, 0.2, 20)).toEqual([]);
    expect(crossedThresholds(21, 5, 20)).toEqual([]);
  });

  it("treats landing exactly on the line as a crossing", () => {
    expect(crossedThresholds(15.5, 0.5, 20)).toEqual([80]);
  });
});
