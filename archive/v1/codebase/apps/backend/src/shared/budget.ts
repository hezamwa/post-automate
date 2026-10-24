// Budget read-model helpers (FR-15.10, design §7 /admin/budget).

/** Linear month-end projection from month-to-date spend, UTC calendar. */
export function projectMonthEndUsd(spentUsd: number, now: Date): number {
  const dayOfMonth = now.getUTCDate(); // 1..31 — never 0
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return (spentUsd / dayOfMonth) * daysInMonth;
}

/**
 * Which alert thresholds (80%, 100% — FR-15.10/15.11) does adding `costUsd` to
 * `spentBeforeUsd` cross? Stateless dedup: only the call that crosses a line reports
 * it, so no repeats while spend sits above a threshold.
 */
export function crossedThresholds(spentBeforeUsd: number, costUsd: number, capUsd: number): number[] {
  return [80, 100].filter((pct) => {
    const line = (capUsd * pct) / 100;
    return spentBeforeUsd < line && spentBeforeUsd + costUsd >= line;
  });
}
