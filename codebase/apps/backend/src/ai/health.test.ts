import { describe, expect, it } from "vitest";
import { errorMessage } from "./health";

// FR-15.5: these strings ARE the product surface — they are stored verbatim and shown
// in the admin dashboard. A message without a remediation makes the admin guess.
describe("errorMessage (FR-15.5)", () => {
  it("names the secret to rotate on an auth failure", () => {
    const msg = errorMessage("auth_error", { provider: "openai" });
    expect(msg).toContain("OPENAI_API_KEY");
    expect(msg).toMatch(/rotate/i);
  });

  it("names the offending model when it is not found", () => {
    const msg = errorMessage("model_not_found", { provider: "openai", model: "gpt-legacy" });
    expect(msg).toContain("gpt-legacy");
  });

  it("reports the fallback that covered a rate limit", () => {
    expect(errorMessage("rate_limited", { provider: "anthropic", fallback: "openai/gpt-5-mini" })).toContain(
      "openai/gpt-5-mini",
    );
  });

  it("states the timeout window it actually waited", () => {
    expect(errorMessage("timeout", { provider: "grok", timeoutSeconds: 45 })).toContain("45s");
  });

  it("falls back to a default window when none was supplied", () => {
    expect(errorMessage("timeout", { provider: "grok" })).toContain("30s");
  });

  it("includes the status code on a provider error", () => {
    expect(errorMessage("provider_error", { provider: "google", code: 503 })).toContain("503");
  });

  it("returns a message for every status, and never an empty one", () => {
    const statuses = [
      "ok", "auth_error", "model_not_found", "rate_limited",
      "quota", "timeout", "provider_error",
    ] as const;
    for (const status of statuses) {
      const msg = errorMessage(status, { provider: "anthropic" });
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toContain("undefined");
    }
  });
});
