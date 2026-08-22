import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

// /admin/monitor + the switch panel (FR-15.11, design §10.1): spend, caps, pipeline,
// route health — and every kill switch with who set it and when, flippable in place.

interface FlagInfo {
  key: string;
  value: boolean | number;
  default: boolean | number;
  overridden: boolean;
  lastChange: {
    newValue: unknown;
    source: string;
    changedAt: string;
    changedBy: { email: string } | null;
  } | null;
}

interface Monitor {
  spend: {
    monthToDateUsd: number;
    byUser: { userId: string | null; usd: number }[];
    byProvider: { provider: string; usd: number }[];
    byTask: { taskType: string; usd: number }[];
    byDay: { day: string; usd: number }[];
  };
  users: {
    id: string;
    email: string;
    displayName: string;
    role: string;
    suspendedAt: string | null;
    suspendedReason: string | null;
    monthlyCapUsd: number;
    spentUsd: number;
  }[];
  pipeline: {
    runsThisMonth: { state: string; n: number }[];
    draftsByStatus: { status: string; n: number }[];
  };
  globalCap: { capUsd: number; spentUsd: number; percentUsed: number };
  switches: FlagInfo[];
  routeHealth: {
    routeId: string;
    taskType: string;
    provider: string;
    model: string;
    enabled: boolean;
    latest: { status: string; message: string; checkedAt: string } | null;
  }[];
}

interface Budget {
  capUsd: number;
  spentUsd: number;
  percentUsed: number;
  projectedMonthEndUsd: number;
}

const SWITCHES = ["ai.paused", "publishing.paused", "runs.paused"];

export function MonitorView() {
  const [data, setData] = useState<Monitor | null>(null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [error, setError] = useState("");
  const [capInput, setCapInput] = useState("");
  const [busy, setBusy] = useState("");
  const [recheck, setRecheck] = useState<{ done: number; total: number } | null>(null);

  const reload = useCallback(async () => {
    try {
      setError("");
      const [m, b] = await Promise.all([api<Monitor>("/admin/monitor"), api<Budget>("/admin/budget")]);
      setData(m);
      setBudget(b);
      setCapInput(String(b.capUsd));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    }
  }, []);
  useEffect(() => void reload(), [reload]);

  async function flipSwitch(flag: FlagInfo) {
    const next = !(flag.value as boolean);
    const verb = next ? "PAUSE" : "resume";
    if (!confirm(`${verb} '${flag.key}'?`)) return;
    setBusy(flag.key);
    try {
      await api(`/admin/flags/${flag.key}`, { method: "PATCH", body: JSON.stringify({ value: next }) });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "flag change failed");
    } finally {
      setBusy("");
    }
  }

  // FR-15.5 "on demand (with re-test)": canary every ENABLED route via the existing
  // per-route test endpoint (which stores the human-readable result), then reload.
  async function recheckAll() {
    if (!data) return;
    const targets = data.routeHealth.filter((r) => r.enabled);
    setError("");
    setRecheck({ done: 0, total: targets.length });
    let failures = 0;
    for (const r of targets) {
      try {
        const { result } = await api<{ result: { status: string } }>(`/admin/ai/routes/${r.routeId}/test`, { method: "POST" });
        if (result.status !== "ok") failures++;
      } catch {
        failures++; // stored result (or the error) shows in the reloaded table
      }
      setRecheck((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
    }
    setRecheck(null);
    if (failures > 0) setError(`Re-check finished: ${failures} of ${targets.length} route(s) not OK — details in the table below.`);
    await reload();
  }

  async function saveCap() {
    setBusy("cap");
    try {
      await api("/admin/budget", { method: "PATCH", body: JSON.stringify({ capUsd: Number(capInput) }) });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "cap change failed");
    } finally {
      setBusy("");
    }
  }

  if (!data || !budget) return <p className="muted">{error || "Loading…"}</p>;
  const users = new Map(data.users.map((u) => [u.id, u]));
  const switches = data.switches.filter((s) => SWITCHES.includes(s.key));

  return (
    <>
      {error && <p className="error">{error}</p>}

      <div className="panel">
        <h2>Kill switches (FR-15.12)</h2>
        <table>
          <thead>
            <tr><th>Switch</th><th>State</th><th>Last change</th><th /></tr>
          </thead>
          <tbody>
            {switches.map((s) => (
              <tr key={s.key}>
                <td><code>{s.key}</code></td>
                <td><span className={`pill ${s.value ? "on" : "off"}`}>{s.value ? "PAUSED" : "active"}</span></td>
                <td className="muted">
                  {s.lastChange
                    ? `${s.lastChange.changedBy?.email ?? s.lastChange.source} · ${new Date(s.lastChange.changedAt).toLocaleString()}`
                    : "never changed"}
                </td>
                <td>
                  <button disabled={busy === s.key} className={s.value ? "primary" : "danger"} onClick={() => void flipSwitch(s)}>
                    {s.value ? "Resume" : "Pause"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid">
        <div className="panel">
          <h2>Global budget (FR-15.10)</h2>
          <p>
            ${budget.spentUsd.toFixed(2)} of ${budget.capUsd} ({budget.percentUsed}%) · projected month-end $
            {budget.projectedMonthEndUsd.toFixed(2)}
          </p>
          <div className={`bar ${budget.percentUsed >= 80 ? "hot" : ""}`}>
            <div style={{ width: `${Math.min(budget.percentUsed, 100)}%` }} />
          </div>
          <div className="row" style={{ marginTop: "0.75rem" }}>
            <div>
              <label>Monthly cap (USD)</label>
              <input value={capInput} onChange={(e) => setCapInput(e.target.value)} style={{ width: "6rem" }} />
            </div>
            <button disabled={busy === "cap"} onClick={() => void saveCap()}>Save cap</button>
          </div>
          <p className="muted">Changes are audited (DR-9.13).</p>
        </div>

        <div className="panel">
          <h2>Per-user spend (FR-15.8)</h2>
          <table>
            <thead><tr><th>User</th><th>Spent</th><th>Cap</th><th>Status</th></tr></thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td>{u.displayName}</td>
                  <td>${u.spentUsd.toFixed(2)}</td>
                  <td>${u.monthlyCapUsd}</td>
                  <td>
                    {u.suspendedAt
                      ? <span className="pill bad" title={u.suspendedReason ?? ""}>suspended</span>
                      : <span className="pill ok">active</span>}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="muted">system (canaries)</td>
                <td className="muted">${(data.spend.byUser.find((r) => r.userId === null)?.usd ?? 0).toFixed(2)}</td>
                <td /><td />
              </tr>
            </tbody>
          </table>
        </div>

        <div className="panel">
          <h2>Spend breakdown</h2>
          <table>
            <thead><tr><th>Task</th><th>USD</th></tr></thead>
            <tbody>
              {data.spend.byTask.map((t) => (
                <tr key={t.taskType}><td>{t.taskType}</td><td>${t.usd.toFixed(3)}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            By provider: {data.spend.byProvider.map((p) => `${p.provider} $${p.usd.toFixed(2)}`).join(" · ") || "—"}
          </p>
        </div>

        <div className="panel">
          <h2>Pipeline (this month)</h2>
          <p>{data.pipeline.runsThisMonth.map((r) => `${r.state}: ${r.n}`).join(" · ") || "no runs yet"}</p>
          <p className="muted">Drafts: {data.pipeline.draftsByStatus.map((d) => `${d.status}: ${d.n}`).join(" · ") || "—"}</p>
        </div>
      </div>

      <div className="panel">
        <div style={{ display: "flex", alignItems: "baseline", gap: "1rem", marginBottom: "0.75rem" }}>
          <h2 style={{ margin: 0 }}>Route health (FR-15.5)</h2>
          <button disabled={recheck !== null} onClick={() => void recheckAll()}>
            {recheck ? `Testing ${recheck.done}/${recheck.total}…` : "Re-check all routes"}
          </button>
          <span className="muted">canaries every enabled route; disabled routes are skipped</span>
        </div>
        <table>
          <thead><tr><th>Task</th><th>Route</th><th>Status</th><th>Last result</th></tr></thead>
          <tbody>
            {data.routeHealth.map((r) => (
              <tr key={r.routeId}>
                <td>{r.taskType}{r.enabled ? "" : " (disabled)"}</td>
                <td>{r.provider}/{r.model}</td>
                <td>
                  {r.latest
                    ? <span className={`pill ${r.latest.status === "ok" ? "ok" : "bad"}`}>{r.latest.status}</span>
                    : <span className="pill none">never tested</span>}
                </td>
                <td className="health-msg muted">{r.latest?.message ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button onClick={() => void reload()}>Refresh</button>
    </>
  );
}
