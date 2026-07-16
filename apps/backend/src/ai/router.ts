import { and, asc, eq, isNull } from "drizzle-orm";
import type { ProviderId, TaskType } from "@post-automate/shared";
import { schema, type Db } from "../db/client";
import type { Env } from "../shared/env";
import { getAdapter } from "./adapters";
import { assertAiAllowed } from "./gates";
import { errorMessage } from "./health";
import { recordSpend } from "./meter";
import type { ChatRequest, ChatResult } from "./types";

/**
 * AI Router (AR-10.9, FR-15.3/15.6) — the ONLY entry point for AI chat work.
 * Task code never imports an adapter or provider SDK.
 *
 * Resolution (design §6.2): per-user override routes, else global defaults,
 * else hard error. Fallbacks (priority 1..n) are tried in order on any failure;
 * every failure is recorded in ai_health_checks with a human-readable message,
 * every success is metered into spend_ledger. Gates run before the first call
 * (design §10): global hard cap, per-user cap + rate limit.
 */

export interface RunTaskArgs {
  taskType: TaskType;
  userId: string | null;
  runId?: string | null;
  input: Omit<ChatRequest, "model">;
  /** Admin-triggered route tests only (design §10 layer 2). */
  bypassGlobalCap?: boolean;
}

export interface RunTaskResult extends ChatResult {
  provider: ProviderId;
  model: string;
  costUsd: number;
}

type RouteRow = typeof schema.aiRoutes.$inferSelect;

export async function runTask(env: Env, db: Db, args: RunTaskArgs): Promise<RunTaskResult> {
  await assertAiAllowed(db, args.userId, { bypassGlobalCap: args.bypassGlobalCap });

  const routes = await resolveRoutes(db, args.taskType, args.userId);
  if (routes.length === 0) {
    throw new Error(`No route configured for task '${args.taskType}' — add one in ai_routes (FR-15.3)`);
  }

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
      return { ...result, provider, model: route.model, costUsd };
    } catch (e) {
      const { status, code } = adapter.classifyError?.(e) ?? { status: "provider_error" as const, code: undefined };
      const detail = e instanceof Error ? e.message.slice(0, 300) : "unknown error";
      await db.insert(schema.aiHealthChecks).values({
        routeId: route.id,
        status,
        message: `${errorMessage(status, { provider, model: route.model, code })} [task=${args.taskType}] :: ${detail}`,
      });
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
  bypassGlobalCap?: boolean;
}

export interface RunImageResult {
  imageBase64: string;
  mimeType: string;
  provider: ProviderId;
  model: string;
  costUsd: number;
}

/** Image counterpart of runTask — same gates, resolution, fallback, and metering. */
export async function runImageTask(env: Env, db: Db, args: RunImageArgs): Promise<RunImageResult> {
  await assertAiAllowed(db, args.userId, { bypassGlobalCap: args.bypassGlobalCap });
  const routes = await resolveRoutes(db, args.taskType, args.userId);
  if (routes.length === 0) {
    throw new Error(`No route configured for task '${args.taskType}' — add one in ai_routes (FR-15.3)`);
  }
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
      return { imageBase64: result.imageBase64, mimeType: result.mimeType, provider, model: route.model, costUsd };
    } catch (e) {
      const { status, code } = adapter.classifyError?.(e) ?? { status: "provider_error" as const, code: undefined };
      const detail = e instanceof Error ? e.message.slice(0, 300) : "unknown error";
      await db.insert(schema.aiHealthChecks).values({
        routeId: route.id,
        status,
        message: `${errorMessage(status, { provider, model: route.model, code })} [task=${args.taskType}] :: ${detail}`,
      });
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
