import { z } from "zod";
import { assertRunnable, GateError, SkipRunError } from "../../ai/gates";
import { createDb } from "../../db/client";
import { defineStep, RETRY } from "./step";

// Entry gates (spec §3 step 1; design §5/§10): caps, rate limit, ai.paused, runs.paused,
// suspension, pending drafts. A cap or pause is a decision (→ failed / skipped), not a
// transient failure — so GateError is never retried.

export const entryOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.string(), kind: z.enum(["pending_drafts", "runs_paused", "inactive"]) }),
]);

export const entryGates = defineStep({
  name: "gates",
  input: z.object({}),
  output: entryOutcomeSchema,
  retries: RETRY.io,
  nonRetryable: [GateError],
  run: async (ctx) => {
    const db = createDb(ctx.env);
    try {
      const run = await db.query.pipelineRuns.findFirst({ where: (r, { eq }) => eq(r.id, ctx.runId), columns: { trigger: true } });
      await assertRunnable(db, ctx.userId, { runId: ctx.runId, userRequested: !!ctx.userTopic, scheduled: run?.trigger === "cron" });
      return { ok: true as const };
    } catch (e) {
      if (e instanceof SkipRunError) return { ok: false as const, reason: e.reason, kind: e.kind };
      throw e;
    }
  },
});
