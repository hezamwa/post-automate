import { TASK_CAPABILITY, TASK_NEEDS_WEB_SEARCH, type ProviderId, type TaskType } from "./ai";

// The rule deciding which model may serve which task (FR-15.2/15.4), as pure functions over
// a list of models. The list itself lives in the ai_models table (since 2026-09-18) so an
// admin can add a provider's model and prices without a deploy — the Worker passes rows it
// read from the database, the dashboard passes rows it fetched from /admin/ai/models, and
// both get the same answer. Nothing here reads a hard-coded registry any more; the seed
// lives in migration 0010.

export interface ModelInfo {
  provider: ProviderId;
  model: string;
  capability: "chat" | "image" | "tts" | "video" | "search";
  inputPerMTokUsd?: number;
  outputPerMTokUsd?: number;
  /** Prompt-cache read / write prices; absent → billed at the input price (never undercounts). */
  cachedInputPerMTokUsd?: number;
  cacheWritePerMTokUsd?: number;
  perImageUsd?: number;
  perSearchUsd?: number;
  notes?: string | null;
}

export function findModel(models: readonly ModelInfo[], provider: string, model: string): ModelInfo | undefined {
  return models.find((m) => m.provider === provider && m.model === model);
}

/**
 * Why this model cannot serve this task — a sentence for an admin, or null if it can.
 *
 * The three clauses are the three ways a route breaks at runtime, in the order they bite:
 *  1. capability — the router dispatches by adapter method (runImageTask → generateImage,
 *     runTask → chat). A model whose capability doesn't match that call fails the task with
 *     "<provider>: no chat capability" (router.ts) every time it is tried.
 *  2. pricing — priceUsage() throws on a missing unit price AFTER the provider has answered,
 *     so an unpriced model bills real money and then fails the run (FR-15.4, meter.ts).
 *  3. web search — discovery/research run LLM-native web search, billed per search; a chat
 *     model with no per-search price hard-fails at metering the moment it searches.
 */
export function modelRejection(info: ModelInfo, taskType: TaskType): string | null {
  const { provider, model } = info;
  const required = TASK_CAPABILITY[taskType];
  if (info.capability !== required) {
    return `${provider}/${model} is a '${info.capability}' model, but task '${taskType}' needs a '${required}' model — the router would fail every call to it (FR-15.2).`;
  }
  if (required === "chat" && (info.inputPerMTokUsd == null || info.outputPerMTokUsd == null)) {
    return `${provider}/${model} has no token prices in the registry — the call would bill the provider and then fail at metering (FR-15.4). Add its prices first.`;
  }
  if (required === "image" && info.perImageUsd == null) {
    return `${provider}/${model} has no per-image price in the registry — the call would bill the provider and then fail at metering (FR-15.4). Add its price first.`;
  }
  if (required === "search" && info.perSearchUsd == null) {
    return `${provider}/${model} has no per-search price in the registry — the call would bill the provider and then fail at metering (FR-15.4). Add its price first.`;
  }
  if (TASK_NEEDS_WEB_SEARCH.has(taskType) && info.perSearchUsd == null) {
    return `Task '${taskType}' uses web search, and ${provider}/${model} has no per-search price in the registry — searching would fail at metering (FR-15.4).`;
  }
  return null;
}

/** modelRejection, looked up by name — null means the route is allowed. */
export function routeRejection(
  models: readonly ModelInfo[],
  provider: string,
  model: string,
  taskType: TaskType,
): string | null {
  const info = findModel(models, provider, model);
  if (!info) {
    return `Model '${model}' is not registered for ${provider} — add it on the Models tab with its unit prices first (FR-15.4).`;
  }
  return modelRejection(info, taskType);
}

/** Models that can actually serve this task, optionally narrowed to one provider. */
export function modelsForTask(
  models: readonly ModelInfo[],
  taskType: TaskType,
  provider?: ProviderId,
): ModelInfo[] {
  return models.filter((m) => (!provider || m.provider === provider) && modelRejection(m, taskType) === null);
}

/** Providers with at least one model that can serve this task. */
export function providersForTask(models: readonly ModelInfo[], taskType: TaskType): ProviderId[] {
  return [...new Set(modelsForTask(models, taskType).map((m) => m.provider))];
}
