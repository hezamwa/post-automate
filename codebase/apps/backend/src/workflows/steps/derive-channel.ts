import type { WorkflowStep } from "cloudflare:workers";
import { z } from "zod";
import { GateError } from "../../ai/gates";
import { NoRouteError } from "../../ai/router";
import { createDb } from "../../db/client";
import { getUserById, recordDerivatives } from "../../db/commands";
import { CHANNELS, deriveChannelText, type ChannelKind } from "../../modules/generation";
import { DECLINED_REASON, kindDecision } from "../../modules/generation/channels";
import { patchDraftFields } from "../../modules/publishing";
import { moduleCtx, profileOf, type RunContext } from "../context";
import { defineStep, RETRY, runStep, type StepDef } from "./step";
import { schema } from "../../db/client";
import { eq } from "drizzle-orm";

// The shape shared by derive-x and derive-linkedin (spec §3 steps 14–15, FR-6.12): after
// approval, one call from the FINAL markdown (the drafts row, edits included), its own
// draft_derivatives row, the field patched onto the Sanity draft, skip-not-fail
// (FR-15.13). Unsupported by the profile → `absent` (no row); unticked at the derivatives
// gate → `declined` (a row, no call). An answer over the channel limit gets ONE corrective
// pass as a separate step, so a failed rewrite never re-bills the first call (spec §3).

export const channelInputSchema = z.object({
  draftId: z.string().uuid(),
  revisionNo: z.number().int().min(0),
  /** Second pass only: the first answer, which ran over the limit. */
  tooLong: z.string().optional(),
});

export const channelOutputSchema = z.object({
  outcome: z.enum(["absent", "declined", "produced", "skipped", "failed"]),
  length: z.number().int().optional(),
  /** Set when produced text exceeds the channel limit — the trigger for the corrective pass. */
  overLimitText: z.string().optional(),
  reason: z.string().optional(),
});
export type ChannelInput = z.infer<typeof channelInputSchema>;
export type ChannelOutput = z.infer<typeof channelOutputSchema>;

const FIELD: Record<ChannelKind, string> = { x: "xVersion", linkedin: "linkedinVersion" };

export function channelStep(kind: ChannelKind): StepDef<ChannelInput, ChannelOutput> {
  const channel = CHANNELS[kind];
  return defineStep({
    name: `derive-${kind}`,
    input: channelInputSchema,
    output: channelOutputSchema,
    bills: channel.taskType,
    retries: RETRY.ai,
    run: async (ctx, input) => {
      const db = createDb(ctx.env);
      const draft = await db.query.drafts.findFirst({ where: eq(schema.drafts.id, input.draftId) });
      if (!draft?.markdown) throw new Error(`draft ${input.draftId} has no markdown to derive from (DR-9.11)`);
      const record = (r: { outcome: "produced" | "skipped" | "failed" | "declined"; content?: string; reason?: string }) =>
        recordDerivatives(db, input.draftId, input.revisionNo, [{ kind, ...r }]);

      const decision = kindDecision(profileOf(ctx), draft.channels as string[] | null, kind);
      if (decision === "absent") return { outcome: "absent" };
      if (decision === "declined") {
        await record({ outcome: "declined", reason: DECLINED_REASON });
        return { outcome: "declined" };
      }
      try {
        const content = await deriveChannelText(ctx.env, db, moduleCtx(ctx), kind, draft.markdown, input.tooLong);
        // A corrective pass only replaces the first answer when it is actually shorter.
        if (input.tooLong && content.length >= input.tooLong.length) return { outcome: "produced", length: input.tooLong.length };
        await record({ outcome: "produced", content });
        if (draft.sanityDocumentId) {
          await patchDraftFields(ctx.env, await getUserById(db, ctx.userId), draft.sanityDocumentId, { [FIELD[kind]]: content });
        }
        return {
          outcome: "produced",
          length: content.length,
          ...(content.length > channel.maxChars && !input.tooLong ? { overLimitText: content } : {}),
        };
      } catch (e) {
        if (e instanceof GateError) throw e; // pauses and caps halt the step (FR-15.12a), never degrade
        const reason =
          e instanceof NoRouteError
            ? `The '${channel.taskType}' capability is disabled — no enabled route (FR-15.13). Re-enable a route and revise the draft to generate it.`
            : e instanceof Error
              ? e.message.slice(0, 300)
              : "unknown error";
        const outcome = e instanceof NoRouteError ? "skipped" : "failed";
        await record({ outcome, reason });
        return { outcome, reason };
      }
    },
  });
}

/** Run a channel step, then — only if its answer ran long — one corrective pass as its own step. */
export async function runChannel(
  step: WorkflowStep,
  ctx: RunContext,
  def: StepDef<ChannelInput, ChannelOutput>,
  input: Omit<ChannelInput, "tooLong">,
  suffix?: string,
): Promise<ChannelOutput> {
  const first = await runStep(step, ctx, def, input, suffix);
  if (!first.overLimitText) return first;
  return runStep(step, ctx, def, { ...input, tooLong: first.overLimitText }, suffix ? `${suffix}-shorten` : "shorten");
}
