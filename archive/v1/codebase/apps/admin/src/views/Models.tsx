import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CAPABILITIES,
  PROVIDERS,
  TASK_CAPABILITY,
  TASK_NEEDS_WEB_SEARCH,
  TASK_TYPES,
  modelRejection,
  type Capability,
  type ModelInfo,
  type ProviderId,
  type TaskType,
} from "@post-automate/shared";
import { api } from "../api";

// Model registry (FR-15.4). Pick a provider and its own live catalogue loads, so a model is
// chosen from a real list instead of typed from memory. Prices are the one thing no
// provider's API returns — every one of them serves ids and capabilities and no cost data —
// so a model registers unpriced in one click and says, in the row, that it cannot be routed
// until someone fills them in (routing refuses unpriced models: meter.ts, FR-15.7).

interface ModelRow extends ModelInfo {
  id: string;
  updatedAt: string;
}

interface CatalogueModel {
  id: string;
  displayName?: string;
  capability: Capability | null;
  guessed: boolean;
}

interface RouteRow {
  id: string;
  userId: string | null;
  taskType: TaskType;
  priority: number;
  provider: string;
  model: string;
}

// Providers whose adapter is a stub: a route to one fails on every call, so the registry
// says so rather than letting someone price a model that cannot be called (design §6.1).
const UNIMPLEMENTED: Partial<Record<ProviderId, string>> = {
  manus: "adapter not implemented yet — API shape needs verifying first (design §13)",
};

// Providers with no catalogue endpoint: their models are added by id (search APIs expose a
// single surface rather than a list of models).
const NO_CATALOGUE: Partial<Record<ProviderId, string>> = {
  tavily: "Tavily has one search surface rather than a model list — add it by id below (e.g. tavily-search).",
  manus: "No model listing published — add models by id below.",
};

type PriceKey = "inputPerMTokUsd" | "outputPerMTokUsd" | "perImageUsd" | "perSearchUsd";

const PRICE_FIELDS: Array<{ key: PriceKey; label: string }> = [
  { key: "inputPerMTokUsd", label: "Input $/Mtok" },
  { key: "outputPerMTokUsd", label: "Output $/Mtok" },
  { key: "perImageUsd", label: "$/image" },
  { key: "perSearchUsd", label: "$/search" },
];

type PriceForm = Record<PriceKey, string>;
const emptyPrices: PriceForm = { inputPerMTokUsd: "", outputPerMTokUsd: "", perImageUsd: "", perSearchUsd: "" };

function pricesToForm(m: ModelInfo): PriceForm {
  return {
    inputPerMTokUsd: m.inputPerMTokUsd?.toString() ?? "",
    outputPerMTokUsd: m.outputPerMTokUsd?.toString() ?? "",
    perImageUsd: m.perImageUsd?.toString() ?? "",
    perSearchUsd: m.perSearchUsd?.toString() ?? "",
  };
}

/** Blank = no price (null), which keeps the model unroutable rather than free. */
function formToPrices(form: PriceForm): Record<PriceKey, number | null> {
  const out = {} as Record<PriceKey, number | null>;
  for (const { key } of PRICE_FIELDS) {
    const raw = form[key].trim();
    out[key] = raw === "" ? null : Number(raw);
  }
  return out;
}

function priceFormInvalid(form: PriceForm): string | null {
  for (const { key, label } of PRICE_FIELDS) {
    const raw = form[key].trim();
    if (raw === "") continue;
    if (!Number.isFinite(Number(raw)) || Number(raw) < 0) return `${label} must be a number, or blank for "no price".`;
  }
  return null;
}

/** Which tasks this model can serve — the same rule the route picker applies. */
function servesTasks(m: ModelInfo): TaskType[] {
  return TASK_TYPES.filter((t) => modelRejection(m, t) === null);
}

function positionLabel(rank: number): string {
  return rank === 0 ? "primary" : `fallback ${rank}`;
}

export function ModelsView() {
  const [models, setModels] = useState<ModelRow[]>([]);
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<{ id: string; capability: Capability; prices: PriceForm } | null>(null);

  // live catalogue
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [catalogue, setCatalogue] = useState<CatalogueModel[]>([]);
  const [catalogueError, setCatalogueError] = useState("");
  const [loadedFor, setLoadedFor] = useState<ProviderId | null>(null);
  const [filter, setFilter] = useState("");
  // per catalogue row: the capability to register with, and the task/rank to route at
  const [picks, setPicks] = useState<Record<string, { capability: Capability; task: TaskType; rank: number }>>({});
  // manual entry, for providers that publish no catalogue
  const [manual, setManual] = useState<{ model: string; capability: Capability }>({ model: "", capability: "chat" });

  const reload = useCallback(async () => {
    try {
      setError("");
      const [m, r] = await Promise.all([
        api<{ models: ModelRow[] }>("/admin/ai/models"),
        api<{ routes: RouteRow[] }>("/admin/ai/routes"),
      ]);
      setModels(m.models);
      setRoutes(r.routes);
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

  const registered = useMemo(() => {
    const map = new Map<string, ModelRow>();
    for (const m of models) map.set(`${m.provider}/${m.model}`, m);
    return map;
  }, [models]);

  const loadCatalogue = (p: ProviderId) =>
    act("catalogue", async () => {
      setCatalogueError("");
      setCatalogue([]);
      try {
        const { models: list } = await api<{ models: CatalogueModel[] }>(`/admin/ai/providers/${p}/models`);
        setCatalogue(list);
        setLoadedFor(p);
      } catch (e) {
        // The provider's own words — an unpaid account or a bad key is diagnosable here,
        // and the rest of the page keeps working.
        setCatalogueError(e instanceof Error ? e.message : "could not load the catalogue");
        setLoadedFor(p);
      }
    });

  const pickFor = (cm: CatalogueModel) =>
    picks[cm.id] ?? { capability: cm.capability ?? "chat", task: "article" as TaskType, rank: 0 };

  // Takes the catalogue row, not just its id, so an untouched field keeps the provider's
  // own capability rather than silently defaulting to chat.
  const setPick = (cm: CatalogueModel, patch: Partial<{ capability: Capability; task: TaskType; rank: number }>) =>
    setPicks((prev) => ({ ...prev, [cm.id]: { ...pickFor(cm), ...prev[cm.id], ...patch } }));

  /** Routes already configured for a task at global scope, in priority order. */
  const chainFor = useCallback(
    (task: TaskType) => routes.filter((r) => r.userId === null && r.taskType === task).sort((a, b) => a.priority - b.priority),
    [routes],
  );

  const addToRegistry = (cm: CatalogueModel) =>
    act(`add-${cm.id}`, async () => {
      setNotice("");
      await api("/admin/ai/models", {
        method: "POST",
        body: JSON.stringify({
          provider,
          model: cm.id,
          capability: pickFor(cm).capability,
          // No prices: no provider publishes them, so they are filled in deliberately.
          inputPerMTokUsd: null,
          outputPerMTokUsd: null,
          perImageUsd: null,
          perSearchUsd: null,
        }),
      });
      setNotice(`${provider}/${cm.id} registered — set its prices before it can be routed.`);
      await reload();
    });

  /**
   * Create the route at the chosen rank. It is always appended first (the free slot, so the
   * (user, task, priority) unique index can never be hit), then moved into place with the
   * reorder endpoint — which is also what shifts the existing fallbacks down.
   */
  const addRoute = (cm: CatalogueModel) =>
    act(`route-${cm.id}`, async () => {
      setNotice("");
      const { task, rank } = pickFor(cm);
      const chain = chainFor(task);
      const { route } = await api<{ route: RouteRow }>("/admin/ai/routes", {
        method: "POST",
        body: JSON.stringify({ taskType: task, provider, model: cm.id, priority: chain.length }),
      });
      if (rank < chain.length) {
        const ordered = chain.map((r) => r.id);
        ordered.splice(rank, 0, route.id);
        await api("/admin/ai/routes/reorder", { method: "POST", body: JSON.stringify({ orderedIds: ordered }) });
      }
      setNotice(`${provider}/${cm.id} routed for '${task}' as ${positionLabel(rank)}.`);
      await reload();
    });

  const addManually = () =>
    act("manual", async () => {
      setNotice("");
      await api("/admin/ai/models", {
        method: "POST",
        body: JSON.stringify({
          provider,
          model: manual.model.trim(),
          capability: manual.capability,
          inputPerMTokUsd: null,
          outputPerMTokUsd: null,
          perImageUsd: null,
          perSearchUsd: null,
        }),
      });
      setNotice(`${provider}/${manual.model.trim()} registered — set its prices before it can be routed.`);
      setManual({ ...manual, model: "" });
      await reload();
    });

  const saveEdit = () =>
    act("edit", async () => {
      if (!editing) return;
      const invalid = priceFormInvalid(editing.prices);
      if (invalid) {
        setError(invalid);
        return;
      }
      await api(`/admin/ai/models/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ capability: editing.capability, ...formToPrices(editing.prices) }),
      });
      setEditing(null);
      await reload();
    });

  const remove = (m: ModelRow) =>
    act(`del-${m.id}`, async () => {
      if (!confirm(`Remove ${m.provider}/${m.model} from the registry?\n\nRoutes pointing at it must be deleted first — the API refuses otherwise.`)) return;
      await api(`/admin/ai/models/${m.id}`, { method: "DELETE" });
      await reload();
    });

  const byProvider = useMemo(() => {
    const map = new Map<string, ModelRow[]>();
    for (const m of models) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models]);

  const visibleCatalogue = useMemo(
    () => (filter ? catalogue.filter((m) => m.id.toLowerCase().includes(filter.toLowerCase())) : catalogue),
    [catalogue, filter],
  );

  return (
    <>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="panel">
        <h2>Provider catalogue (live)</h2>
        <div className="row">
          <div>
            <label>Provider</label>
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as ProviderId);
                setCatalogue([]);
                setCatalogueError("");
                setLoadedFor(null);
              }}
            >
              {PROVIDERS.map((p) => <option key={p}>{p}</option>)}
            </select>
          </div>
          <button className="primary" disabled={busy === "catalogue"} onClick={() => void loadCatalogue(provider)}>
            {busy === "catalogue" ? "Loading…" : "Load models"}
          </button>
          {catalogue.length > 0 && (
            <div>
              <label>Filter</label>
              <input style={{ width: "12rem" }} placeholder="gemini-2.5" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          )}
          {loadedFor === provider && !catalogueError && (
            <span className="muted">{visibleCatalogue.length} of {catalogue.length} shown</span>
          )}
        </div>

        {UNIMPLEMENTED[provider] && <p className="notice">{provider}: {UNIMPLEMENTED[provider]}.</p>}
        {NO_CATALOGUE[provider] && <p className="notice">{NO_CATALOGUE[provider]}</p>}
        {catalogueError && <p className="error">{catalogueError}</p>}

        <div className="row" style={{ marginTop: "0.75rem" }}>
          <div>
            <label>Add by id (no catalogue needed)</label>
            <input
              style={{ width: "16rem" }}
              placeholder="tavily-search"
              value={manual.model}
              onChange={(e) => setManual({ ...manual, model: e.target.value })}
            />
          </div>
          <div>
            <label>Capability</label>
            <select value={manual.capability} onChange={(e) => setManual({ ...manual, capability: e.target.value as Capability })}>
              {CAPABILITIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <button
            disabled={busy === "manual" || !manual.model.trim() || registered.has(`${provider}/${manual.model.trim()}`)}
            onClick={() => void addManually()}
          >
            {registered.has(`${provider}/${manual.model.trim()}`) ? "Already registered" : `Add to ${provider}`}
          </button>
        </div>

        {visibleCatalogue.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th style={{ width: "9rem" }}>Capability</th>
                <th>Status</th>
                <th style={{ width: "23rem" }}>Add</th>
              </tr>
            </thead>
            <tbody>
              {visibleCatalogue.map((cm) => {
                const known = registered.get(`${provider}/${cm.id}`);
                const pick = pickFor(cm);
                const serves = known ? servesTasks(known) : [];
                const unpriced = known && serves.length === 0;
                const chain = chainFor(pick.task);
                const alreadyRouted = chain.some((r) => r.provider === provider && r.model === cm.id);
                return (
                  <tr key={cm.id}>
                    <td>
                      {cm.id}
                      {cm.displayName && cm.displayName !== cm.id && <div className="muted">{cm.displayName}</div>}
                    </td>
                    <td>
                      {known ? (
                        <span className="muted">{known.capability}</span>
                      ) : (
                        <>
                          <select
                            value={pick.capability}
                            onChange={(e) => setPick(cm, { capability: e.target.value as Capability })}
                          >
                            {CAPABILITIES.map((c) => <option key={c}>{c}</option>)}
                          </select>
                          <div className="muted">
                            {cm.capability === null
                              ? "not stated — pick one"
                              : cm.guessed
                                ? "guessed from the id"
                                : "from the provider"}
                          </div>
                        </>
                      )}
                    </td>
                    <td>
                      {!known ? (
                        <span className="muted">not registered</span>
                      ) : unpriced ? (
                        <span className="error" style={{ margin: 0 }}>
                          ⚠ Price required — this model cannot be routed until its prices are set.
                        </span>
                      ) : (
                        <span className="muted">
                          <span className="pill ok">registered</span> serves {serves.join(", ")}
                        </span>
                      )}
                    </td>
                    <td>
                      {!known ? (
                        <button className="primary" disabled={busy === `add-${cm.id}`} onClick={() => void addToRegistry(cm)}>
                          Add to registry
                        </button>
                      ) : unpriced ? (
                        <button
                          onClick={() => setEditing({ id: known.id, capability: known.capability, prices: pricesToForm(known) })}
                        >
                          Set prices
                        </button>
                      ) : (
                        <div className="row" style={{ marginBottom: 0 }}>
                          <div>
                            <label>Function</label>
                            <select value={pick.task} onChange={(e) => setPick(cm, { task: e.target.value as TaskType, rank: 0 })}>
                              {TASK_TYPES.map((t) => (
                                <option key={t} disabled={!serves.includes(t)}>
                                  {t}
                                  {serves.includes(t) ? "" : " — cannot serve"}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label>Rank</label>
                            <select value={pick.rank} onChange={(e) => setPick(cm, { rank: Number(e.target.value) })}>
                              {Array.from({ length: chain.length + 1 }, (_, i) => (
                                <option key={i} value={i}>{positionLabel(i)}</option>
                              ))}
                            </select>
                          </div>
                          <button
                            className="primary"
                            disabled={busy === `route-${cm.id}` || !serves.includes(pick.task) || alreadyRouted}
                            onClick={() => void addRoute(cm)}
                          >
                            {alreadyRouted ? "Routed" : "Add route"}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted">
          No provider publishes prices through its API — ids and capabilities only — so a model is registered unpriced
          and priced here afterwards. Routes created from this table are global defaults; per-user overrides live on the
          Routes tab. Inserting at an occupied rank shifts the existing fallbacks down (FR-15.6).
        </p>
      </div>

      <div className="panel">
        <h2>Registered models (FR-15.4)</h2>
        {byProvider.map(([prov, rows]) => (
          <div key={prov} style={{ marginBottom: "1rem" }}>
            <h2 style={{ marginBottom: "0.25rem" }}>
              {prov}
              {UNIMPLEMENTED[prov as ProviderId] && (
                <span className="muted" style={{ fontWeight: 400 }}> · {UNIMPLEMENTED[prov as ProviderId]}</span>
              )}
            </h2>
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th style={{ width: "6rem" }}>Capability</th>
                  <th>Prices (USD)</th>
                  <th>Serves</th>
                  <th style={{ width: "11rem" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const isEditing = editing !== null && editing.id === m.id;
                  const serves = servesTasks(m);
                  return (
                    <tr key={m.id}>
                      <td>{m.model}</td>
                      <td>
                        {isEditing ? (
                          <select
                            value={editing.capability}
                            onChange={(e) => setEditing({ ...editing, capability: e.target.value as Capability })}
                          >
                            {CAPABILITIES.map((c) => <option key={c}>{c}</option>)}
                          </select>
                        ) : (
                          m.capability
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <div className="row" style={{ marginBottom: 0 }}>
                            {PRICE_FIELDS.map((f) => (
                              <div key={f.key}>
                                <label>{f.label}</label>
                                <input
                                  style={{ width: "6rem" }}
                                  placeholder="none"
                                  value={editing.prices[f.key]}
                                  onChange={(e) =>
                                    setEditing({ ...editing, prices: { ...editing.prices, [f.key]: e.target.value } })
                                  }
                                />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="muted">
                            {PRICE_FIELDS.filter((f) => m[f.key] != null).map((f) => `${f.label} ${m[f.key]}`).join(" · ") || (
                              <span className="error" style={{ margin: 0 }}>⚠ Price required — not routable until set.</span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="muted health-msg">
                        {serves.length > 0 ? (
                          serves.join(", ")
                        ) : (
                          <span className="pill none">no task</span>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <>
                            <button className="primary" disabled={busy === "edit"} onClick={() => void saveEdit()}>Save</button>{" "}
                            <button onClick={() => setEditing(null)}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => setEditing({ id: m.id, capability: m.capability, prices: pricesToForm(m) })}>
                              Edit
                            </button>{" "}
                            <button className="danger" disabled={busy === `del-${m.id}`} onClick={() => void remove(m)}>
                              Remove
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
          A '{TASK_CAPABILITY.article}' model needs both token prices; an image model needs a per-image price; and
          {" "}{[...TASK_NEEDS_WEB_SEARCH].join("/")} additionally need a per-search price. Blank means unknown — the
          router refuses the model rather than recording a free call.
        </p>
      </div>
    </>
  );
}
