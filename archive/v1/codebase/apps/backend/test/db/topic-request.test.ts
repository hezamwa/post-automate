import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "../../src/db/client";
import { recordDerivatives, setDraftBlogType, setRunAngleProposals } from "../../src/db/commands";
import { getDraftDetail, listDraftsWithDerivatives } from "../../src/db/queries";
import { checkTopicRequest } from "../../src/modules/discovery";
import { techProfile } from "../fixtures";
import { createTestDb, seedRun, seedUser, type TestDb } from "./harness";

// FR-5.8/FR-7.7 pre-flight for user-requested topics + the read models the app drives
// the angle picker and review screen from.

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
});

const profile = techProfile({
  topicPolicy: {
    interests: [{ topic: "ai tooling", weight: 5 }],
    bannedTopics: ["politics", "unannounced projects"],
  },
});

async function seedCoveredTopic(userId: string, title: string, daysAgo: number, selected = true) {
  const runId = await seedRun(db, userId);
  await db.insert(schema.topicCandidates).values({
    runId,
    userId,
    title,
    summary: "s",
    selected,
    createdAt: new Date(Date.now() - daysAgo * 24 * 3600_000),
  });
}

describe("checkTopicRequest (FR-7.7)", () => {
  it("flags banned-topic collisions case-insensitively, in title and notes", async () => {
    const userId = await seedUser(db);
    const inTitle = await checkTopicRequest(db, profile, userId, { title: "The Politics of AI" });
    expect(inTitle.bannedCollisions).toEqual(["politics"]);
    const inNotes = await checkTopicRequest(db, profile, userId, {
      title: "Roadmaps",
      notes: "cover our UNANNOUNCED PROJECTS too",
    });
    expect(inNotes.bannedCollisions).toEqual(["unannounced projects"]);
  });

  it("returns no collisions for a clean request", async () => {
    const userId = await seedUser(db);
    const result = await checkTopicRequest(db, profile, userId, { title: "RAG in the enterprise" });
    expect(result.bannedCollisions).toEqual([]);
    expect(result.similarRecentTopics).toEqual([]);
  });

  it("informs about similar topics covered in the last 30 days — and only those", async () => {
    const userId = await seedUser(db, { maxRunsPerDay: 99 });
    await seedCoveredTopic(userId, "Enterprise RAG patterns in 2026", 5);
    await seedCoveredTopic(userId, "Enterprise RAG patterns (old)", 45); // outside the window
    await seedCoveredTopic(userId, "Enterprise RAG rejected candidate", 5, false); // never selected
    const result = await checkTopicRequest(db, profile, userId, { title: "enterprise rag patterns" });
    expect(result.similarRecentTopics).toEqual(["Enterprise RAG patterns in 2026"]);
  });
});

describe("setRunAngleProposals (FR-6.3, FR-7.9)", () => {
  it("persists the proposals for the app's angle picker and change-angle", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    const proposals = {
      angles: [{ headline: "A" }, { headline: "B" }, { headline: "C" }],
      recommendedIndex: 1,
    };
    await setRunAngleProposals(db, runId, proposals);
    const run = await db.query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, runId) });
    expect(run?.angleProposals).toEqual(proposals);
  });
});

describe("listDraftsWithDerivatives (DR-9.14 read model)", () => {
  it("returns each draft with ONLY its latest revision's derivative rows", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    const [draft] = await db
      .insert(schema.drafts)
      .values({ userId, runId, markdown: "# x" })
      .returning({ id: schema.drafts.id });
    await recordDerivatives(db, draft!.id, 0, [
      { kind: "x", outcome: "produced", content: "v0" },
      { kind: "hero_image", outcome: "produced", assetRef: "image-abc" },
    ]);
    await recordDerivatives(db, draft!.id, 1, [
      { kind: "x", outcome: "produced", content: "v1" },
      { kind: "translation", outcome: "failed", reason: "no enabled route" },
    ]);

    const [row] = await listDraftsWithDerivatives(db, userId);
    expect(row?.derivatives).toHaveLength(2);
    expect(row?.derivatives.find((d) => d.kind === "x")).toMatchObject({ content: "v1", revisionNo: 1 });
    expect(row?.derivatives.find((d) => d.kind === "translation")).toMatchObject({
      outcome: "failed",
      reason: "no enabled route",
    });
    // rev-0 hero not shown: the latest revision replaced the derivative set (FR-7.9)
    expect(row?.derivatives.some((d) => d.kind === "hero_image")).toBe(false);
  });

  it("serves the review-screen detail: markdown, latest derivatives, run angle proposals", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    await setRunAngleProposals(db, runId, { angles: [{ headline: "A" }], recommendedIndex: 0 });
    const [draft] = await db
      .insert(schema.drafts)
      .values({ userId, runId, markdown: "# body", angle: { headline: "A" } })
      .returning({ id: schema.drafts.id });
    await recordDerivatives(db, draft!.id, 0, [{ kind: "x", outcome: "produced", content: "post" }]);

    const detail = await getDraftDetail(db, userId, draft!.id);
    expect(detail?.draft).toMatchObject({ id: draft!.id, markdown: "# body", status: "pending_approval" });
    expect(detail?.derivatives).toEqual([
      expect.objectContaining({ kind: "x", outcome: "produced", content: "post" }),
    ]);
    expect(detail?.run).toMatchObject({ state: "discovering", angleProposals: { recommendedIndex: 0 } });

    // FR-2.3: a foreign draft reads as absent
    const other = await seedUser(db);
    expect(await getDraftDetail(db, other, draft!.id)).toBeNull();

    // harness user: tech-less profile state, non-Afnan Sanity project
    expect(detail?.medical).toBe(false);
    expect(detail?.supportsBlogType).toBe(false);
  });

  it("gates the review screen: medical checklist + Afnan's per-draft blogType (FR-6.8, design §8)", async () => {
    const [user] = await db
      .insert(schema.users)
      .values({
        email: `afnan-${crypto.randomUUID()}@example.com`,
        displayName: "A",
        passwordHash: "x",
        sanityProjectId: "5gz3ngjs",
      })
      .returning({ id: schema.users.id });
    await db.insert(schema.profiles).values({
      userId: user!.id,
      version: 1,
      status: "active",
      payload: { domain: { field: "medical" } }, // read-model peeks at domain.field only
      schemaVersion: 2,
    });
    const runId = await seedRun(db, user!.id);
    const [draft] = await db
      .insert(schema.drafts)
      .values({ userId: user!.id, runId, markdown: "# x" })
      .returning({ id: schema.drafts.id });

    const detail = await getDraftDetail(db, user!.id, draft!.id);
    expect(detail?.medical).toBe(true);
    expect(detail?.supportsBlogType).toBe(true);

    // the reviewer's choice lands on the draft row for the publish-time patch
    await setDraftBlogType(db, draft!.id, "em");
    expect((await getDraftDetail(db, user!.id, draft!.id))?.draft.blogType).toBe("em");
  });

  it("returns an empty derivatives list for a draft with none, and scopes by user", async () => {
    const userId = await seedUser(db);
    const other = await seedUser(db);
    const runId = await seedRun(db, userId);
    await db.insert(schema.drafts).values({ userId, runId, markdown: "# x" });
    const mine = await listDraftsWithDerivatives(db, userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.derivatives).toEqual([]);
    expect(await listDraftsWithDerivatives(db, other)).toHaveLength(0);
  });
});
