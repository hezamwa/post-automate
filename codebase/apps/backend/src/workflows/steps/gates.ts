import { z } from "zod";
import { assertRunnable, GateError, SkipRunError } from "../../ai/gates";
import { createDb } from "../../db/client";
import { defineStep, RETRY } from "./step";

// Entry gates (spec §3 step 1; design §5/§10): caps, rate limit, ai.paused, runs.paused,
// suspension, pending drafts. A cap or pause is a decision (→ failed / skipped), not a
// transient failure — so GateError is never retried.

export const entryOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.string(), kind: z.enum(["pending_drafts", "runs_paused"]) }),
]);

export const entryGates = defineStep({
  name: "gates",
  input: z.object({}),
  output: entryOutcomeSchema,
  retries: RETRY.io,
  nonRetryable: [GateError],
  run: async (ctx) => {
    try {
      await assertRunnable(createDb(ctx.env), ctx.userId, { runId: ctx.runId, userRequested: !!ctx.userTopic });
      return { ok: true as const };
    } catch (e) {
      if (e instanceof SkipRunError) return { ok: false as const, reason: e.reason, kind: e.kind };
      throw e;
    }
  },
});
