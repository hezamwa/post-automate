import type { WorkflowStep } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, schema } from "../../db/client";
import { setRunState } from "../../db/commands";
import { getDraftByRun } from "../../db/queries";
import { approvedKinds, supportedKinds, type DerivativeKind } from "../../modules/generation/channels";
import { profileOf, type RunContext } from "../context";
import type { ApprovalEventPayload } from "./draft";
import { applyGate, defineGate } from "./gate";

// The derivatives gate (spec §4.1/§4.3): multi-select over X · LinkedIn · Arabic edition —
// only the kinds the profile supports, pre-ticked from the profile. Rendered on the
// approve screen, NO separate pause: the selection arrives in the approve payload as
// `channels`. With `auto` the checkboxes are hidden and the profile decides.

const TITLES: Record<DerivativeKind, string> = { x: "X post", linkedin: "LinkedIn post", translation: "Translated edition" };

export const derivativesChoiceSchema = z.object({ selected: z.array(z.enum(["x", "linkedin", "translation"])) }).strict();
export type DerivativesChoice = z.infer<typeof derivativesChoiceSchema>;

export const derivativesGate = defineGate<DerivativesChoice>({
  name: "derivatives",
  options: async (ctx) => {
    const supported = supportedKinds(profileOf(ctx));
    return {
      options: supported.map((k) => ({ id: k, title: TITLES[k], summary: "", why: "" })),
      preselected: supported,
    };
  },
  choice: derivativesChoiceSchema,
  recommended: async (ctx) => ({ selected: supportedKinds(profileOf(ctx)) }),
  /** drafts.channels is what the derive steps read; the run enters its publishing phase. */
  apply: async (ctx, choice) => {
    const db = createDb(ctx.env);
    const draft = await getDraftByRun(db, ctx.runId);
    if (!draft) throw new Error(`run ${ctx.runId} has no draft`);
    await db.update(schema.drafts).set({ channels: approvedKinds(profileOf(ctx), choice.selected) }).where(eq(schema.drafts.id, draft.id));
    await setRunState(db, ctx.runId, "publishing");
  },
});

/** Resolve from the approve payload — no wait (spec §4.1): ask → the ticked set, auto → the profile. */
export async function resolveDerivatives(step: WorkflowStep, ctx: RunContext, decision: ApprovalEventPayload, suffix?: string): Promise<DerivativesChoice> {
  const options = await derivativesGate.options(ctx);
  const auto = profileOf(ctx).gates.derivatives === "auto";
  const choice = auto || !decision.channels ? await derivativesGate.recommended(ctx) : { selected: decision.channels };
  return applyGate(step, ctx, derivativesGate, choice, { optionsShown: options, source: auto ? "auto" : "user" }, suffix);
}
