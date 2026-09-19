import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { schema } from "../../../src/db/client";
import { derivativesGate, resolveDerivatives } from "../../../src/workflows/gates/derivatives";
import { techProfile } from "../../fixtures";
import { draftRow, runRow, seedDraftRow, stepContext } from "../harness";

// The derivatives gate (spec §4.1): multi-select over what the profile supports, pre-ticked,
// answered on the approve screen — no pause. auto = the profile decides.
beforeEach(resetShared);
const arabic = (gates = {}) => techProfile({ translation: { enabled: true, targetLanguage: "ar" }, gates });

describe("derivatives gate", () => {
  it("offers only the kinds the profile supports, all pre-ticked", async () => {
    const ctx = await stepContext({ profile: arabic() });
    expect(await derivativesGate.options(ctx)).toEqual({
      options: [{ id: "x", title: "X post", summary: "", why: "" }, { id: "linkedin", title: "LinkedIn post", summary: "", why: "" }, { id: "translation", title: "Translated edition", summary: "", why: "" }],
      preselected: ["x", "linkedin", "translation"],
    });
    expect((await derivativesGate.options(await stepContext({ profile: techProfile({ channels: ["x"] }) }))).options.map((o) => o.id)).toEqual(["x"]);
  });

  it("ask (the default): the ticked set from the approve payload, narrowed to the profile, no wait", async () => {
    const ctx = await stepContext({ profile: arabic() });
    await seedDraftRow(ctx);
    await resolveDerivatives(shared.step as never, ctx, { action: "approve", channels: ["x", "translation"] });
    expect(shared.step.waits).toEqual([]);
    expect((await draftRow(ctx.runId))?.channels).toEqual(["x", "translation"]);
    expect((await runRow(ctx.runId))?.state).toBe("publishing");
    expect(await shared.db.select().from(schema.gateChoices).where(eq(schema.gateChoices.runId, ctx.runId))).toMatchObject([{ gate: "derivatives", source: "user", choice: { selected: ["x", "translation"] } }]);
  });

  it("ask without a selection in the payload → the profile decides", async () => {
    const ctx = await stepContext({ profile: arabic() });
    await seedDraftRow(ctx);
    await resolveDerivatives(shared.step as never, ctx, { action: "approve" });
    expect((await draftRow(ctx.runId))?.channels).toEqual(["x", "linkedin", "translation"]);
  });

  it("auto: the profile decides and the payload's selection is ignored", async () => {
    const ctx = await stepContext({ profile: arabic({ derivatives: "auto" }) });
    await seedDraftRow(ctx);
    await resolveDerivatives(shared.step as never, ctx, { action: "approve", channels: ["x"] });
    expect((await draftRow(ctx.runId))?.channels).toEqual(["x", "linkedin", "translation"]);
    expect(await shared.db.select().from(schema.gateChoices).where(eq(schema.gateChoices.runId, ctx.runId))).toMatchObject([{ source: "auto" }]);
  });
});
