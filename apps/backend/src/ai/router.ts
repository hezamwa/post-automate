import type { TaskType } from "@post-automate/shared";
import type { Env } from "../shared/env";
import type { ChatRequest, ChatResult } from "./types";

/**
 * AI Router (AR-10.9, FR-15.3/15.6) — the ONLY entry point for AI work.
 * Task code never imports an adapter or provider SDK.
 *
 * Resolution (design §6.2):
 *   1. ai_routes WHERE user_id = :userId AND task_type = :t AND enabled   (per-user override)
 *   2. ai_routes WHERE user_id IS NULL  AND task_type = :t AND enabled   (global default)
 *   3. hard error "No route configured for task '{t}'"
 * Fallbacks (priority 1..n) are tried on auth/quota/rate-limit/timeout/5xx; every attempt
 * is metered (meter.ts) and every failure recorded in ai_health_checks.
 *
 * Gates checked before every call (design §10): global hard cap (FR-15.10),
 * per-user cap + rate limits (FR-15.8).
 */
export async function runTask(
  _env: Env,
  _taskType: TaskType,
  _userId: string | null,
  _input: Omit<ChatRequest, "model">,
): Promise<ChatResult> {
  // TODO(phase-1): route resolution, gates, adapter dispatch, fallback chain, metering
  throw new Error("ai.runTask not implemented yet — see docs/design.md §6.2");
}
