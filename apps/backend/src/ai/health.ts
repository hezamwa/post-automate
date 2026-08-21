import type { HealthStatus } from "@post-automate/shared";

// Human-readable error mapping (FR-15.5, design §6.3). Stored verbatim in ai_health_checks
// and returned by /admin/ai/routes/:id/test — these messages are the product surface.
export function errorMessage(
  status: HealthStatus,
  ctx: { provider: string; model?: string; fallback?: string; timeoutSeconds?: number; code?: number },
): string {
  switch (status) {
    case "ok":
      return "OK — model responded.";
    case "auth_error":
      return `Authentication failed — the ${ctx.provider} API key is invalid or expired. Rotate the ${ctx.provider.toUpperCase()}_API_KEY secret and re-test.`;
    case "model_not_found":
      // ctx.model is optional — never interpolate it raw, these strings are stored
      // verbatim and shown to the admin (FR-15.5).
      return `${ctx.model ? `Model '${ctx.model}'` : "The configured model"} was not found on ${ctx.provider} — it may be renamed or retired. Choose a different model for this route.`;
    case "rate_limited":
    case "quota":
      return `Rate limited / quota exhausted on ${ctx.provider}.${ctx.fallback ? ` Fallback '${ctx.fallback}' was used;` : ""} consider raising the provider quota.`;
    case "timeout":
      return `No response from ${ctx.provider} within ${ctx.timeoutSeconds ?? 30}s — likely a provider outage or network issue. Re-test in a few minutes.`;
    case "provider_error":
      return `${ctx.provider} returned a server error (${ctx.code ?? "5xx"}). Usually transient; the fallback route was used.`;
  }
}

// ── Route canary (FR-15.5): POST /admin/ai/routes/:id/test ───────────────────────────
// Calls the route's adapter healthCheck directly — deliberately NOT through runTask:
// a route test must exercise THE route, never its fallbacks, and explicitly
// admin-triggered tests bypass ai.paused and the global cap by design (§10/§10.1).
// TODO(phase-4): daily re-test of all enabled routes from the dispatcher (design §6.3).

import { desc, eq } from "drizzle-orm";
import type { ProviderId } from "@post-automate/shared";
import { getAdapter } from "./adapters";
import { schema, type Db } from "../db/client";
import type { Env } from "../shared/env";

export interface RouteTestResult {
  routeId: string;
  taskType: string;
  provider: string;
  model: string;
  status: HealthStatus;
  latencyMs: number;
  message: string; // human-readable, stored verbatim (FR-15.5)
}

/** FR-15.6/design §6.3: a primary route's last two checks both failing ⇒ admin push. */
export async function primaryRouteFailedTwice(db: Db, routeId: string): Promise<boolean> {
  const last = await db
    .select({ status: schema.aiHealthChecks.status })
    .from(schema.aiHealthChecks)
    .where(eq(schema.aiHealthChecks.routeId, routeId))
    .orderBy(desc(schema.aiHealthChecks.checkedAt))
    .limit(2);
  return last.length === 2 && last.every((c) => c.status !== "ok");
}

export async function testRoute(env: Env, db: Db, routeId: string): Promise<RouteTestResult | null> {
  const route = await db.query.aiRoutes.findFirst({ where: eq(schema.aiRoutes.id, routeId) });
  if (!route) return null;

  const adapter = getAdapter(route.provider as ProviderId, env);
  const result = await adapter.healthCheck(route.model);
  // Success carries the latency (design §6.3: "OK — model responded in 812 ms");
  // failures get the remediation catalogue's message with the raw detail appended.
  const message =
    result.status === "ok"
      ? `OK — model responded in ${result.latencyMs} ms.`
      : `${errorMessage(result.status, { provider: route.provider, model: route.model })} :: ${result.message}`;

  await db.insert(schema.aiHealthChecks).values({
    routeId: route.id,
    status: result.status,
    latencyMs: result.latencyMs,
    message,
  });
  return {
    routeId: route.id,
    taskType: route.taskType,
    provider: route.provider,
    model: route.model,
    status: result.status,
    latencyMs: result.latencyMs,
    message,
  };
}
