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
      return `Model '${ctx.model}' was not found on ${ctx.provider} — it may be renamed or retired. Choose a different model for this route.`;
    case "rate_limited":
    case "quota":
      return `Rate limited / quota exhausted on ${ctx.provider}.${ctx.fallback ? ` Fallback '${ctx.fallback}' was used;` : ""} consider raising the provider quota.`;
    case "timeout":
      return `No response from ${ctx.provider} within ${ctx.timeoutSeconds ?? 30}s — likely a provider outage or network issue. Re-test in a few minutes.`;
    case "provider_error":
      return `${ctx.provider} returned a server error (${ctx.code ?? "5xx"}). Usually transient; the fallback route was used.`;
  }
}

// TODO(phase-1): canary runners per capability (chat: max_tokens 8 ping; image: smallest size;
// search: trivial query) + daily re-test from the dispatcher. Admin-triggered tests bypass
// the global cap by design (§10).
