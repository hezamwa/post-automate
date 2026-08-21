import { useCallback, useEffect, useState } from "react";
import { PROVIDERS, TASK_TYPES } from "@post-automate/shared";
import { api } from "../api";

// AI routing CRUD + per-route test (FR-15.3/15.5): global defaults and per-user
// overrides as data, with the stored human-readable test result shown inline.

interface Route {
  id: string;
  userId: string | null;
  taskType: string;
  priority: number;
  provider: string;
  model: string;
  enabled: boolean;
  version: number;
}

interface TestResult {
  status: string;
  latencyMs: number;
  message: string;
}

export function RoutesView() {
  const [routes, setRoutes] = useState<Route[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [form, setForm] = useState({ taskType: "article", provider: "anthropic", model: "", priority: "0" });

  const reload = useCallback(async () => {
    try {
      setError("");
      setRoutes((await api<{ routes: Route[] }>("/admin/ai/routes")).routes);
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

  const test = (r: Route) =>
    act(`test-${r.id}`, async () => {
      const { result } = await api<{ result: TestResult }>(`/admin/ai/routes/${r.id}/test`, { method: "POST" });
      setTestResults((prev) => ({ ...prev, [r.id]: result }));
    });

  const toggle = (r: Route) =>
    act(`toggle-${r.id}`, async () => {
      await api(`/admin/ai/routes/${r.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !r.enabled }) });
      await reload();
    });

  const create = () =>
    act("create", async () => {
      await api("/admin/ai/routes", {
        method: "POST",
        body: JSON.stringify({
          taskType: form.taskType,
          provider: form.provider,
          model: form.model,
          priority: Number(form.priority),
        }),
      });
      setForm({ ...form, model: "" });
      await reload();
    });

  return (
    <>
      {error && <p className="error">{error}</p>}
      <div className="panel">
        <h2>Routing configuration (FR-15.3)</h2>
        <table>
          <thead>
            <tr><th>Task</th><th>Scope</th><th>Route</th><th>Prio</th><th>v</th><th>Enabled</th><th>Test (FR-15.5)</th></tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr key={r.id}>
                <td>{r.taskType}</td>
                <td className="muted">{r.userId ? "user override" : "global"}</td>
                <td>{r.provider}/{r.model}</td>
                <td>{r.priority === 0 ? "primary" : `fallback ${r.priority}`}</td>
                <td className="muted">{r.version}</td>
                <td>
                  <button disabled={busy === `toggle-${r.id}`} onClick={() => void toggle(r)}>
                    {r.enabled ? "Disable" : "Enable"}
                  </button>
                </td>
                <td>
                  <button disabled={busy === `test-${r.id}`} onClick={() => void test(r)}>
                    {busy === `test-${r.id}` ? "Testing…" : "Test"}
                  </button>
                  {testResults[r.id] && (
                    <div className={`muted health-msg`}>
                      <span className={`pill ${testResults[r.id]!.status === "ok" ? "ok" : "bad"}`}>
                        {testResults[r.id]!.status}
                      </span>{" "}
                      {testResults[r.id]!.message}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Disabling the last enabled route for a task disables that capability — optional derivatives skip,
          articles fail the run naming the task (FR-15.13). Admin tests bypass ai.paused and the global cap (§10.1).
        </p>
      </div>

      <div className="panel">
        <h2>Add route</h2>
        <div className="row">
          <div>
            <label>Task type</label>
            <select value={form.taskType} onChange={(e) => setForm({ ...form, taskType: e.target.value })}>
              {TASK_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label>Provider</label>
            <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
              {PROVIDERS.map((p) => <option key={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label>Model (must be in the registry, FR-15.4)</label>
            <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </div>
          <div>
            <label>Priority (0 = primary)</label>
            <input value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} style={{ width: "4rem" }} />
          </div>
          <button className="primary" disabled={busy === "create" || !form.model} onClick={() => void create()}>
            Add
          </button>
        </div>
      </div>
    </>
  );
}
