import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "./preamble";
import { schema } from "../../src/db/client";
import { recordDerivatives } from "../../src/db/commands";
import { approveDirect, rejectDirect } from "../../src/workflows/direct";
import { techProfile } from "../fixtures";
import { derivativeRows, draftRow, runRow, seedDraftRow, startRun, env } from "./harness";

// Direct handling (spec §5.1): a pending draft whose Workflow instance is gone is still
// approved — derivatives from the final markdown, then publish — or rejected, by running
// the same step definitions inline.
beforeEach(resetShared);

async function pendingDraft(profile = techProfile()) {
  const params = await startRun({ profile });
  const docId = `drafts.postauto-${params.runId}`;
  shared.sanity.docs.set(docId, { _id: docId, _type: "post", title: "T" });
  const draftId = await seedDraftRow(params, { markdown: "# final", sanityDocumentId: docId, angle: { headline: "H" } });
  await recordDerivatives(shared.db, draftId, 0, [{ kind: "hero_image", outcome: "produced", assetRef: "image-1" }]);
  const draft = (await shared.db.query.drafts.findFirst({ where: (d, { eq }) => eq(d.id, draftId) }))!;
  return { params, draft };
}

describe("approveDirect", () => {
  it("applies the approval, derives the ticked channels from the final text and publishes", async () => {
    const { params, draft } = await pendingDraft(techProfile({ translation: { enabled: true, targetLanguage: "ar" } }));
    const status = await approveDirect(env, shared.db, {
      draft,
      decision: { action: "approve", publishMode: "now", editedMarkdown: "# edited final", channels: ["x", "translation"] },
    });
    expect(status).toBe("published");
    expect(await draftRow(params.runId)).toMatchObject({ status: "published", markdown: null, channels: ["x", "translation"] });
    expect((await runRow(params.runId))?.state).toBe("published");
    const rows = await derivativeRows(draft.id);
    expect(rows.map((d) => [d.kind, d.outcome]).sort()).toEqual([["hero_image", "produced"], ["linkedin", "declined"], ["translation", "produced"], ["x", "produced"]]);
    expect(shared.ai.callsFor("shorten_x")[0]!.input.messages[0]!.content).toBe("# edited final");
    expect(shared.sanity.docs.get(`postauto-${params.runId}`)).toMatchObject({ xVersion: "short post" });
    expect(shared.sanity.docs.has(`postauto-${params.runId}-ar`)).toBe(true);
    expect(shared.step.billedTasks("(inline)")).toEqual(["shorten_x", "translate"]); // nothing for the declined channel
  });

  it("schedules for the next slot without publishing", async () => {
    const { params, draft } = await pendingDraft();
    expect(await approveDirect(env, shared.db, { draft, decision: { action: "approve", publishMode: "next_slot" } })).toBe("scheduled");
    expect(await draftRow(params.runId)).toMatchObject({ status: "scheduled" });
    expect((await runRow(params.runId))?.state).toBe("publishing");
  });

  it("uses the run's PINNED profile version, not the active one", async () => {
    const { params, draft } = await pendingDraft(techProfile({ channels: ["x"] }));
    // a newer active profile adds LinkedIn — the run was pinned to v1 without it
    await shared.db.update(schema.profiles).set({ status: "superseded" }).where(eq(schema.profiles.userId, params.userId));
    await shared.db.insert(schema.profiles).values({ userId: params.userId, version: 2, status: "active", payload: techProfile(), schemaVersion: 2 });
    await approveDirect(env, shared.db, { draft, decision: { action: "approve" } });
    expect((await derivativeRows(draft.id)).map((d) => d.kind).sort()).toEqual(["hero_image", "x"]);
  });
});

describe("rejectDirect", () => {
  it("deletes the Sanity draft, stores the category, purges the markdown and closes the run", async () => {
    const { params, draft } = await pendingDraft();
    await rejectDirect(env, shared.db, { draft, category: "changed_mind" });
    expect(shared.sanity.docs.size).toBe(0);
    expect(await draftRow(params.runId)).toMatchObject({ status: "rejected", rejectionCategory: "changed_mind", markdown: null });
    expect(await runRow(params.runId)).toMatchObject({ state: "rejected", error: "rejected: changed_mind" });
  });
});
