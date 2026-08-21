import { and, asc, eq, isNull } from "drizzle-orm";
import type { ProviderId, TaskType } from "@post-automate/shared";
import { schema, type Db } from "../db/client";
import type { Env } from "../shared/env";
import { maybeBudgetAlerts, notifyAdmins } from "../shared/notify";
import { getAdapter } from "./adapters";
import { assertAiAllowed } from "./gates";
import { errorMessage, primaryRouteFailedTwice } from "./health";
import { recordSpend } from "./meter";
import type { ChatRequest, ChatResult } from "./types";

/** FR-15.6: record the failure, and push to admins when a PRIMARY route fails twice running. */
async function recordRouteFailure(
  env: Env,
  db: Db,
  route: RouteRow,
  taskType: TaskType,
  e: unknown,
): Promise<string> {
  const adapter = getAdapter(route.provider as ProviderId, env);
  const { status, code } = adapter.classifyError?.(e) ?? { status: "provider_error" as const, code: undefined };
  const detail = e instanceof Error ? e.message.slice(0, 300) : "unknown error";
  await db.insert(schema.aiHealthChecks).values({
    routeId: route.id,
    status,
    message: `${errorMessage(status, { provider: route.provider, model: route.model, code })} [task=${taskType}] :: ${detail}`,
  });
  if (route.priority === 0 && (await primaryRouteFailedTwice(db, route.id))) {
    await notifyAdmins(env, db, {
      title: `Primary route failing: ${route.provider}/${route.model}`,
      body: `The primary '${taskType}' route has failed twice in a row (${status}). ${errorMessage(status, { provider: route.provider, model: route.model, code })}`,
    });
  }
  return status;
}

/**
 * AI Router (AR-10.9, FR-15.3/15.6) — the ONLY entry point for AI chat work.
 * Task code never imports an adapter or provider SDK.
 *
 * Resolution (design §6.2): per-user override routes, else global defaults,
 * else hard error. Fallbacks (priority 1..n) are tried in order on any failure;
 * every failure is recorded in ai_health_checks with a human-readable message,
 * every success is metered into spend_ledger. Gates run before the first call
 * (design §10/§10.1): ai.paused kill switch, global hard cap, per-user cap + rate limit.
 */

/**
 * Every enabled route for the task type is gone (FR-15.3 disable, FR-15.13). Typed so
 * derivative callers can degrade — skip or mark failed — instead of failing the run;
 * for task types required to produce a draft (article) it propagates and fails the run,
 * naming the task type.
 */
export class NoRouteError extends Error {
  constructor(public taskType: TaskType) {
    super(`No route configured for task '${taskType}' — add one in ai_routes (FR-15.3)`);
    this.name = "NoRouteError";
  }
}

export interface RunTaskArgs {
  taskType: TaskType;
  userId: string | null;
  runId?: string | null;
  input: Omit<ChatRequest, "model">;
  /** Admin-triggered route tests only — bypasses ai.paused and the global cap (design §10/§10.1). */
  adminRouteTest?: boolean;
}

export interface RunTaskResult extends ChatResult {
  provider: ProviderId;
  model: string;
  costUsd: number;
}

type RouteRow = typeof schema.aiRoutes.$inferSelect;

export async function runTask(env: Env, db: Db, args: RunTaskArgs): Promise<RunTaskResult> {
  const gate = await assertAiAllowed(db, args.userId, { adminRouteTest: args.adminRouteTest });

  const routes = await resolveRoutes(db, args.taskType, args.userId);
  if (routes.length === 0) throw new NoRouteError(args.taskType);

  const failures: string[] = [];
  for (const route of routes) {
    const provider = route.provider as ProviderId;
    const adapter = getAdapter(provider, env);
    if (!adapter.chat) {
      failures.push(`${provider}: no chat capability`);
      continue;
    }
    const routeParams = (route.params ?? {}) as { maxTokens?: number };
    try {
      const result = await adapter.chat({
        model: route.model,
        ...args.input,
        maxTokens: args.input.maxTokens ?? routeParams.maxTokens,
      });
      const costUsd = await recordSpend(db, {
        userId: args.userId,
        runId: args.runId,
        taskType: args.taskType,
        provider,
        model: route.model,
        usage: result.usage,
      });
      await maybeBudgetAlerts(env, db, { gate, costUsd, userId: args.userId }); // 80%/100% pushes (FR-15.11)
      return { ...result, provider, model: route.model, costUsd };
    } catch (e) {
      const status = await recordRouteFailure(env, db, route, args.taskType, e);
      failures.push(`${provider}/${route.model} → ${status}`);
      // fall through to the next-priority route (FR-15.6)
    }
  }
  throw new Error(
    `All ${routes.length} route(s) failed for task '${args.taskType}': ${failures.join("; ")}. See ai_health_checks for details (FR-15.6).`,
  );
}

export interface RunImageArgs {
  taskType: TaskType; // "image"
  userId: string | null;
  runId?: string | null;
  prompt: string;
  size?: string;
  quality?: string;
  /** Admin-triggered route tests only — bypasses ai.paused and the global cap (design §10/§10.1). */
  adminRouteTest?: boolean;
}

export interface RunImageResult {
  imageBase64: string;
  mimeType: string;
  provider: ProviderId;
  model: string;
  costUsd: number;
}

/** Image counterpart of runTask — same gates, resolution, fallback, metering, and alerts. */
export async function runImageTask(env: Env, db: Db, args: RunImageArgs): Promise<RunImageResult> {
  const gate = await assertAiAllowed(db, args.userId, { adminRouteTest: args.adminRouteTest });
  const routes = await resolveRoutes(db, args.taskType, args.userId);
  if (routes.length === 0) throw new NoRouteError(args.taskType);
  const failures: string[] = [];
  for (const route of routes) {
    const provider = route.provider as ProviderId;
    const adapter = getAdapter(provider, env);
    if (!adapter.generateImage) {
      failures.push(`${provider}: no image capability`);
      continue;
    }
    const params = (route.params ?? {}) as { size?: string; quality?: string };
    try {
      const result = await adapter.generateImage({
        model: route.model,
        prompt: args.prompt,
        size: args.size ?? params.size,
        quality: args.quality ?? params.quality,
      });
      const costUsd = await recordSpend(db, {
        userId: args.userId,
        runId: args.runId,
        taskType: args.taskType,
        provider,
        model: route.model,
        usage: result.usage,
      });
      await maybeBudgetAlerts(env, db, { gate, costUsd, userId: args.userId }); // 80%/100% pushes (FR-15.11)
      return { imageBase64: result.imageBase64, mimeType: result.mimeType, provider, model: route.model, costUsd };
    } catch (e) {
      const status = await recordRouteFailure(env, db, route, args.taskType, e);
      failures.push(`${provider}/${route.model} → ${status}`);
    }
  }
  throw new Error(
    `All ${routes.length} route(s) failed for task '${args.taskType}': ${failures.join("; ")}. See ai_health_checks (FR-15.6).`,
  );
}

async function resolveRoutes(db: Db, taskType: TaskType, userId: string | null): Promise<RouteRow[]> {
  if (userId) {
    const overrides = await db
      .select()
      .from(schema.aiRoutes)
      .where(
        and(
          eq(schema.aiRoutes.userId, userId),
          eq(schema.aiRoutes.taskType, taskType),
          eq(schema.aiRoutes.enabled, true),
        ),
      )
      .orderBy(asc(schema.aiRoutes.priority));
    if (overrides.length > 0) return overrides;
  }
  return db
    .select()
    .from(schema.aiRoutes)
    .where(
      and(
        isNull(schema.aiRoutes.userId),
        eq(schema.aiRoutes.taskType, taskType),
        eq(schema.aiRoutes.enabled, true),
      ),
    )
    .orderBy(asc(schema.aiRoutes.priority));
}
