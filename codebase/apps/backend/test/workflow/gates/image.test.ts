import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { chooseImage, imageGate } from "../../../src/workflows/gates/image";
import { techProfile } from "../../fixtures";
import { runRow, stepContext } from "../harness";

// The image gate (spec §4.3): 2–3 concepts or "no hero image"; free text is a custom concept.
beforeEach(resetShared);
const input = { title: "T", excerpt: "E" };

describe("image gate", () => {
  it("auto: the first concept, recorded, no wait", async () => {
    const ctx = await stepContext();
    expect(await chooseImage(shared.step as never, ctx, input)).toBe("Glowing nodes on a dark field");
    expect(shared.step.executed).toEqual(["image-concepts", "gate-image"]);
    expect((await runRow(ctx.runId))?.chosenImageConcept).toBe("Glowing nodes on a dark field");
  });

  it("offers the concepts plus a no-image option", async () => {
    const ctx = await stepContext();
    await chooseImage(shared.step as never, ctx, input);
    const options = await imageGate.options(ctx);
    expect(options.options.map((o) => o.id)).toEqual(["c1", "c2", "c3", "none"]);
    expect("recommended" in options && options.recommended).toBe("c1");
  });

  it("ask: a pick, none, or a custom concept in the creator's words", async () => {
    const pick = await stepContext({ profile: techProfile({ gates: { image: "ask" } }) });
    shared.step.script({ type: "gate-image", payload: { optionId: "c3" } });
    expect(await chooseImage(shared.step as never, pick, input)).toBe("A lighthouse beam over data waves");

    const { FakeStep } = await import("../fake-step");
    shared.step = new FakeStep();
    const none = await stepContext({ profile: techProfile({ gates: { image: "ask" } }) });
    shared.step.script({ type: "gate-image", payload: { optionId: "none" } });
    expect(await chooseImage(shared.step as never, none, input)).toBeNull();
    expect((await runRow(none.runId))?.chosenImageConcept).toBe("none");

    shared.step = new FakeStep();
    const custom = await stepContext({ profile: techProfile({ gates: { image: "ask" } }) });
    shared.step.script({ type: "gate-image", payload: { freeText: "a hand-drawn map of the city" } });
    expect(await chooseImage(shared.step as never, custom, input)).toBe("a hand-drawn map of the city");
  });
});
