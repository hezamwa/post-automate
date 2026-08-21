import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

// User management (FR-2.5/2.6/2.7, FR-15.8): create (temp password shown once),
// suspend/reactivate with a reason, erase, and per-user limits.

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  sanityProjectId: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
}

interface Limits {
  monthlyCapUsd: number;
  maxRunsPerDay: number;
  maxReqPerMin: number;
}

export function UsersView({ selfId }: { selfId: string }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);
  const [limitsFor, setLimitsFor] = useState<{ userId: string; limits: Limits; spentUsd: number } | null>(null);
  const [form, setForm] = useState({ email: "", displayName: "", role: "user", sanityProjectId: "" });

  const reload = useCallback(async () => {
    try {
      setError("");
      setUsers((await api<{ users: UserRow[] }>("/admin/users")).users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    }
  }, []);
  useEffect(() => void reload(), [reload]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "action failed");
    } finally {
      setBusy("");
    }
  }

  const suspend = (u: UserRow) =>
    act(u.id, async () => {
      const reason = prompt(`Suspend ${u.displayName} — reason (shown to them at login, FR-2.7):`);
      if (!reason) return;
      await api(`/admin/users/${u.id}/suspend`, { method: "POST", body: JSON.stringify({ reason }) });
      await reload();
    });

  const reactivate = (u: UserRow) =>
    act(u.id, async () => {
      await api(`/admin/users/${u.id}/suspend`, { method: "DELETE" });
      await reload();
    });

  const erase = (u: UserRow) =>
    act(u.id, async () => {
      if (!confirm(`ERASE ${u.displayName} (${u.email})? All personal records are deleted; spend is anonymized; published content stays (FR-2.6). This cannot be undone.`)) return;
      await api(`/admin/users/${u.id}`, { method: "DELETE" });
      await reload();
    });

  const openLimits = (u: UserRow) =>
    act(`limits-${u.id}`, async () => {
      const res = await api<{ userId: string; limits: Limits; spentUsd: number }>(`/admin/users/${u.id}/limits`);
      setLimitsFor(res);
    });

  const saveLimits = () =>
    act("save-limits", async () => {
      if (!limitsFor) return;
      await api(`/admin/users/${limitsFor.userId}/limits`, {
        method: "PATCH",
        body: JSON.stringify(limitsFor.limits),
      });
      setLimitsFor(null);
    });

  const create = () =>
    act("create", async () => {
      const res = await api<{ user: { email: string }; tempPassword: string }>("/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email: form.email,
          displayName: form.displayName,
          role: form.role,
          ...(form.sanityProjectId ? { sanityProjectId: form.sanityProjectId } : {}),
        }),
      });
      setTempPassword({ email: res.user.email, password: res.tempPassword });
      setForm({ email: "", displayName: "", role: "user", sanityProjectId: "" });
      await reload();
    });

  return (
    <>
      {error && <p className="error">{error}</p>}
      {tempPassword && (
        <div className="notice">
          Temp password for <strong>{tempPassword.email}</strong> (shown once — store it now):{" "}
          <code>{tempPassword.password}</code> <button onClick={() => setTempPassword(null)}>Dismiss</button>
        </div>
      )}

      <div className="panel">
        <h2>Users (FR-2.5)</h2>
        <table>
          <thead>
            <tr><th>Name</th><th>Email</th><th>Role</th><th>Sanity</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td className="muted">{u.sanityProjectId ?? "—"}</td>
                <td>
                  {u.suspendedAt
                    ? <span className="pill bad" title={u.suspendedReason ?? ""}>suspended</span>
                    : <span className="pill ok">active</span>}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button disabled={busy === `limits-${u.id}`} onClick={() => void openLimits(u)}>Limits</button>{" "}
                  {u.suspendedAt ? (
                    <button disabled={busy === u.id} onClick={() => void reactivate(u)}>Reactivate</button>
                  ) : (
                    <button disabled={busy === u.id || u.id === selfId} onClick={() => void suspend(u)}>Suspend</button>
                  )}{" "}
                  <button className="danger" disabled={busy === u.id || u.id === selfId} onClick={() => void erase(u)}>
                    Erase
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {limitsFor && (
        <div className="panel">
          <h2>Limits (FR-15.8) — ${limitsFor.spentUsd.toFixed(2)} spent this month</h2>
          <div className="row">
            <div>
              <label>Monthly cap (USD)</label>
              <input
                value={limitsFor.limits.monthlyCapUsd}
                onChange={(e) => setLimitsFor({ ...limitsFor, limits: { ...limitsFor.limits, monthlyCapUsd: Number(e.target.value) } })}
                style={{ width: "5rem" }}
              />
            </div>
            <div>
              <label>Runs / day</label>
              <input
                value={limitsFor.limits.maxRunsPerDay}
                onChange={(e) => setLimitsFor({ ...limitsFor, limits: { ...limitsFor.limits, maxRunsPerDay: Number(e.target.value) } })}
                style={{ width: "4rem" }}
              />
            </div>
            <div>
              <label>Requests / min</label>
              <input
                value={limitsFor.limits.maxReqPerMin}
                onChange={(e) => setLimitsFor({ ...limitsFor, limits: { ...limitsFor.limits, maxReqPerMin: Number(e.target.value) } })}
                style={{ width: "4rem" }}
              />
            </div>
            <button className="primary" disabled={busy === "save-limits"} onClick={() => void saveLimits()}>Save</button>
            <button onClick={() => setLimitsFor(null)}>Cancel</button>
          </div>
          <p className="muted">Suspension is an account state, never a $0 cap (FR-2.7).</p>
        </div>
      )}

      <div className="panel">
        <h2>Create user — data, not code (FR-2.5)</h2>
        <div className="row">
          <div>
            <label>Email</label>
            <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label>Display name</label>
            <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </div>
          <div>
            <label>Role</label>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div>
            <label>Sanity project id (FR-8.5)</label>
            <input value={form.sanityProjectId} onChange={(e) => setForm({ ...form, sanityProjectId: e.target.value })} />
          </div>
          <button className="primary" disabled={busy === "create" || !form.email || !form.displayName} onClick={() => void create()}>
            Create
          </button>
        </div>
      </div>
    </>
  );
}
