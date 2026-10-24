import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TASK_CAPABILITY,
  TASK_NEEDS_WEB_SEARCH,
  TASK_TYPES,
  modelsForTask,
  providersForTask,
  type ModelInfo,
  type ProviderId,
  type TaskType,
} from "@post-automate/shared";
import { api } from "../api";

// AI routing CRUD + per-route test (FR-15.3/15.5). Routes are shown as what they actually
// are — one ordered fallback chain per task (FR-15.6) — rather than a flat table, because
// the order IS the behaviour. Provider/model come from the shared registry via
// modelsForTask() over the registry fetched from /admin/ai/models, so every combination this
// UI offers is one the API accepts: the picker and the validator are the same rule, applied
// to the same rows (models.ts). Add a provider's model on the Models tab and it appears here.

interface Route {
  id: string;
  userId: string | null;
  taskType: TaskType;
  priority: number;
  provider: string;
  model: string;
  params: Record<string, unknown>;
  enabled: boolean;
  version: number;
}

interface TestResult {
  status: string;
  latencyMs: number;
  message: string;
}

interface UserRow {
  id: string;
  displayName: string;
  email: string;
}

const GLOBAL = "global";

/** Params a route can carry, by what the router reads for that task (router.ts). */
function paramFields(taskType: TaskType): Array<{ key: string; label: string; placeholder: string }> {
  return TASK_CAPABILITY[taskType] === "image"
    ? [
        { key: "size", label: "Size", placeholder: "1024x1024" },
        { key: "quality", label: "Quality", placeholder: "standard" },
      ]
    : [{ key: "maxTokens", label: "Max tokens", placeholder: "provider default" }];
}

function paramsToForm(params: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(params ?? {}).map(([k, v]) => [k, String(v ?? "")]));
}

function formToParams(form: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(form)) {
    const trimmed = v.trim();
    if (!trimmed) continue; // absent = provider default, never an empty string
    out[k] = k === "maxTokens" ? Number(trimmed) : trimmed;
  }
  return out;
}

function positionLabel(priority: number): string {
  return priority === 0 ? "primary" : `fallback ${priority}`;
}

export function RoutesView() {
  const [routes, setRoutes] = useState<Route[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [scope, setScope] = useState<string>(GLOBAL);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [editing, setEditing] = useState<{ id: string; provider: string; model: string; params: Record<string, string> } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [addTask, setAddTask] = useState<TaskType>("article");
  const [addForm, setAddForm] = useState<{ provider: string; model: string; params: Record<string, string> }>({
    provider: "",
    model: "",
    params: {},
  });

  const reload = useCallback(async () => {
    try {
      setError("");
      setRoutes((await api<{ routes: Route[] }>("/admin/ai/routes")).routes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    }
  }, []);

  useEffect(() => void reload(), [reload]);
  useEffect(() => {
    // Scope selector needs the user list; a failure here must not blank the routes table.
    void api<{ users: UserRow[] }>("/admin/users")
      .then((r) => setUsers(r.users))
      .catch(() => setUsers([]));
  }, []);

  const reloadModels = useCallback(async () => {
    try {
      setModels((await api<{ models: ModelInfo[] }>("/admin/ai/models")).models);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load the model registry");
    }
  }, []);
  useEffect(() => void reloadModels(), [reloadModels]);

  // The add form's defaults can only be chosen once the registry has arrived; an empty
  // model with a populated <select> renders as if the first option were already chosen.
  useEffect(() => {
    if (models.length === 0 || addForm.provider) return;
    const provider = providersForTask(models, addTask)[0] ?? "";
    setAddForm({ provider, model: modelsForTask(models, addTask, provider as ProviderId)[0]?.model ?? "", params: {} });
  }, [models, addTask, addForm.provider]);

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

  const scopedUserId = scope === GLOBAL ? null : scope;

  // One chain per task, in priority order — disabled routes included, since priority is
  // unique across the whole chain and a reorder has to renumber all of it.
  const chains = useMemo(() => {
    const byTask = new Map<TaskType, Route[]>();
    for (const r of routes) {
      if ((r.userId ?? null) !== scopedUserId) continue;
      const list = byTask.get(r.taskType) ?? [];
      list.push(r);
      byTask.set(r.taskType, list);
    }
    for (const list of byTask.values()) list.sort((a, b) => a.priority - b.priority);
    return [...byTask.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [routes, scopedUserId]);

  const globalTasks = useMemo(
    () => new Set(routes.filter((r) => r.userId === null).map((r) => r.taskType)),
    [routes],
  );

  // Registry models that can serve the task being added (strict: capability, prices, and
  // web search for discovery/research — the three ways a route fails at runtime).
  const addProviders = useMemo(() => providersForTask(models, addTask), [models, addTask]);
  const addModels = useMemo(
    () => modelsForTask(models, addTask, (addForm.provider || addProviders[0]) as ProviderId | undefined),
    [models, addTask, addForm.provider, addProviders],
  );
  const addChainLength = useMemo(
    () => routes.filter((r) => (r.userId ?? null) === scopedUserId && r.taskType === addTask).length,
    [routes, scopedUserId, addTask],
  );

  function pickTask(taskType: TaskType) {
    setAddTask(taskType);
    const provider = providersForTask(models, taskType)[0] ?? "";
    const model = modelsForTask(models, taskType, provider as ProviderId)[0]?.model ?? "";
    setAddForm({ provider, model, params: {} });
  }

  function pickProvider(provider: string) {
    const model = modelsForTask(models, addTask, provider as ProviderId)[0]?.model ?? "";
    setAddForm((f) => ({ ...f, provider, model }));
  }

  const create = () =>
    act("create", async () => {
      await api("/admin/ai/routes", {
        method: "POST",
        body: JSON.stringify({
          taskType: addTask,
          provider: addForm.provider || addProviders[0],
          model: addForm.model,
          // Next free slot in this chain — priority is never typed, so the (user, task,
          // priority) unique index can no longer be hit by hand (FR-15.3).
          priority: addChainLength,
          params: formToParams(addForm.params),
          ...(scopedUserId ? { userId: scopedUserId } : {}),
        }),
      });
      setAddForm((f) => ({ ...f, params: {} }));
      await reload();
    });

  const saveEdit = () =>
    act("edit", async () => {
      if (!editing) return;
      await api(`/admin/ai/routes/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          provider: editing.provider,
          model: editing.model,
          params: formToParams(editing.params),
        }),
      });
      setEditing(null);
      await reload();
    });

  const remove = (r: Route) =>
    act(`del-${r.id}`, async () => {
      const last = chains.find(([t]) => t === r.taskType)?.[1].filter((x) => x.enabled).length === 1 && r.enabled;
      const warning = last
        ? `\n\nThis is the last enabled route for '${r.taskType}' — deleting it turns that capability off (FR-15.13).`
        : "";
      if (!confirm(`Delete ${r.provider}/${r.model} (${positionLabel(r.priority)}) for '${r.taskType}'?${warning}\n\nIts health-check history goes with it. Spend history and draft provenance are unaffected.`)) {
        return;
      }
      await api(`/admin/ai/routes/${r.id}`, { method: "DELETE" });
      await reload();
    });

  const move = (chain: Route[], index: number, delta: number) =>
    act(`move-${chain[index]!.id}`, async () => {
      const next = [...chain];
      const [row] = next.splice(index, 1);
      next.splice(index + delta, 0, row!);
      await api("/admin/ai/routes/reorder", {
        method: "POST",
        body: JSON.stringify({ orderedIds: next.map((r) => r.id) }),
      });
      await reload();
    });

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

  return (
    <>
      {error && <p className="error">{error}</p>}

      <div className="panel">
        <h2>Routing configuration (FR-15.3)</h2>
        <div className="row">
          <div>
            <label>Scope</label>
            <select value={scope} onChange={(e) => { setScope(e.target.value); setEditing(null); }}>
              <option value={GLOBAL}>Global defaults</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>Override for {u.displayName}</option>
              ))}
            </select>
          </div>
          <p className="muted" style={{ margin: 0, maxWidth: "36rem" }}>
            {scopedUserId
              ? "A user's overrides REPLACE the global chain for that task — the globals are not appended as extra fallbacks (router.ts resolveRoutes)."
              : "Defaults for every user without an override for the same task."}
          </p>
        </div>

        {chains.length === 0 && (
          <p className="muted">
            {scopedUserId
              ? "No overrides for this user — every task falls through to the global defaults."
              : "No routes configured."}
          </p>
        )}

        {chains.map(([taskType, chain]) => (
          <div key={taskType} style={{ marginBottom: "1rem" }}>
            <h2 style={{ marginBottom: "0.25rem" }}>
              {taskType}{" "}
              <span className="muted" style={{ fontWeight: 400 }}>
                · {TASK_CAPABILITY[taskType]}
                {TASK_NEEDS_WEB_SEARCH.has(taskType) ? " + web search" : ""}
                {scopedUserId && globalTasks.has(taskType) ? " · replaces the global chain" : ""}
              </span>
            </h2>
            <table>
              <thead>
                <tr>
                  <th style={{ width: "6.5rem" }}>Order</th>
                  <th>Route</th>
                  <th style={{ width: "4rem" }}>v</th>
                  <th>Test (FR-15.5)</th>
                  <th style={{ width: "20rem" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {chain.map((r, i) => {
                  const isEditing = editing !== null && editing.id === r.id;
                  const editModels = modelsForTask(models, taskType, (editing?.provider ?? r.provider) as ProviderId);
                  return (
                    <tr key={r.id} style={r.enabled ? undefined : { opacity: 0.55 }}>
                      <td>
                        <button
                          title="Move earlier"
                          disabled={i === 0 || busy === `move-${r.id}`}
                          onClick={() => void move(chain, i, -1)}
                        >
                          ↑
                        </button>{" "}
                        <button
                          title="Move later"
                          disabled={i === chain.length - 1 || busy === `move-${r.id}`}
                          onClick={() => void move(chain, i, 1)}
                        >
                          ↓
                        </button>
                        <div className="muted">{positionLabel(r.priority)}</div>
                      </td>
                      <td>
                        {isEditing ? (
                          <div className="row" style={{ marginBottom: 0 }}>
                            <select
                              value={editing.provider}
                              onChange={(e) => {
                                const provider = e.target.value;
                                const model = modelsForTask(models, taskType, provider as ProviderId)[0]?.model ?? "";
                                setEditing({ ...editing, provider, model });
                              }}
                            >
                              {providersForTask(models, taskType).map((p) => <option key={p}>{p}</option>)}
                            </select>
                            <select
                              value={editing.model}
                              onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                            >
                              {editModels.map((m) => <option key={m.model}>{m.model}</option>)}
                            </select>
                            {paramFields(taskType).map((f) => (
                              <div key={f.key}>
                                <label>{f.label}</label>
                                <input
                                  style={{ width: "8rem" }}
                                  placeholder={f.placeholder}
                                  value={editing.params[f.key] ?? ""}
                                  onChange={(e) =>
                                    setEditing({ ...editing, params: { ...editing.params, [f.key]: e.target.value } })
                                  }
                                />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <>
                            {r.provider}/{r.model}
                            {Object.keys(r.params ?? {}).length > 0 && (
                              <div className="muted">
                                {Object.entries(r.params).map(([k, v]) => `${k}=${String(v)}`).join(" · ")}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="muted">{r.version}</td>
                      <td>
                        {testResults[r.id] && (
                          <div className="muted health-msg">
                            <span className={`pill ${testResults[r.id]!.status === "ok" ? "ok" : "bad"}`}>
                              {testResults[r.id]!.status}
                            </span>{" "}
                            {testResults[r.id]!.message}
                          </div>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <>
                            <button className="primary" disabled={busy === "edit"} onClick={() => void saveEdit()}>
                              Save
                            </button>{" "}
                            <button onClick={() => setEditing(null)}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() =>
                                setEditing({ id: r.id, provider: r.provider, model: r.model, params: paramsToForm(r.params) })
                              }
                            >
                              Edit
                            </button>{" "}
                            <button disabled={busy === `test-${r.id}`} onClick={() => void test(r)}>
                              {busy === `test-${r.id}` ? "Testing…" : "Test"}
                            </button>{" "}
                            <button disabled={busy === `toggle-${r.id}`} onClick={() => void toggle(r)}>
                              {r.enabled ? "Disable" : "Enable"}
                            </button>{" "}
                            <button className="danger" disabled={busy === `del-${r.id}`} onClick={() => void remove(r)}>
                              Delete
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

        <p className="muted">
          Disabling or deleting the last enabled route for a task disables that capability — optional derivatives skip,
          articles fail the run naming the task (FR-15.13). Admin tests bypass ai.paused and the global cap (§10.1).
        </p>
      </div>

      <div className="panel">
        <h2>Add route</h2>
        <div className="row">
          <div>
            <label>Task type</label>
            <select value={addTask} onChange={(e) => pickTask(e.target.value as TaskType)}>
              {TASK_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label>Provider</label>
            <select
              value={addForm.provider || addProviders[0] || ""}
              disabled={addProviders.length === 0}
              onChange={(e) => pickProvider(e.target.value)}
            >
              {addProviders.map((p) => <option key={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label>Model (registry, FR-15.4)</label>
            <select
              value={addForm.model}
              disabled={addModels.length === 0}
              onChange={(e) => setAddForm({ ...addForm, model: e.target.value })}
            >
              {addModels.map((m) => <option key={m.model}>{m.model}</option>)}
            </select>
          </div>
          {paramFields(addTask).map((f) => (
            <div key={f.key}>
              <label>{f.label}</label>
              <input
                style={{ width: "8rem" }}
                placeholder={f.placeholder}
                value={addForm.params[f.key] ?? ""}
                onChange={(e) => setAddForm({ ...addForm, params: { ...addForm.params, [f.key]: e.target.value } })}
              />
            </div>
          ))}
          <button
            className="primary"
            disabled={busy === "create" || !addForm.model || addModels.length === 0}
            onClick={() => void create()}
          >
            Add as {positionLabel(addChainLength)}
          </button>
        </div>
        {addModels.length === 0 ? (
          <p className="notice">
            No registered model can serve '{addTask}' — it needs a '{TASK_CAPABILITY[addTask]}' model
            {TASK_NEEDS_WEB_SEARCH.has(addTask) ? " priced for web search" : ""} with unit prices (FR-15.4).
            Add one on the Models tab.
          </p>
        ) : (
          <p className="muted">
            Only models that can actually serve '{addTask}' are listed: right capability, and priced for what the call
            bills — an unpriced model would bill the provider and then fail at metering. Priority is assigned
            automatically as the next slot in the chain.
          </p>
        )}
      </div>
    </>
  );
}
