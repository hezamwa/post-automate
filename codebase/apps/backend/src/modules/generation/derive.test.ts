import { beforeEach, describe, expect, it, vi } from "vitest";
import { GateError } from "../../ai/gates";
import { NoRouteError, runTask } from "../../ai/router";
import type { Db } from "../../db/client";
import type { Env } from "../../shared/env";
import { techProfile } from "../../../test/fixtures";
import { deriveTexts, type Article } from "./index";

// FR-15.13 skip-not-fail matrix for text derivatives. The AI router is mocked at its
// boundary (never the database — deriveTexts touches the DB only through the router);
// each scenario asserts the per-kind outcome the review screen will render (DR-9.14).

vi.mock("../../ai/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/router")>();
  return { ...actual, runTask: vi.fn(), runImageTask: vi.fn() };
});

const runTaskMock = vi.mocked(runTask);
const env = {} as Env;
const db = {} as Db; // only ever handed to the (mocked) router

const article: Article = {
  title: "T",
  slug: "t",
  excerpt: "e",
  tags: [],
  imageAlt: "alt",
  markdown: "# hello world",
};

function ctxWith(overrides: Parameters<typeof techProfile>[0] = {}) {
  return { userId: "u1", runId: "r1", profile: techProfile(overrides) };
}

const TRANSLATED = {
  title: "عنوان",
  excerpt: "ملخص",
  imageAlt: "وصف",
  markdown: "# مرحبا",
};

beforeEach(() => {
  runTaskMock.mockReset();
  // shorten tasks read .text; the structured translate task reads .parsed
  runTaskMock.mockImplementation(async (_e, _d, args) =>
    (args.taskType === "translate" ? { parsed: TRANSLATED } : { text: "tiny post" }) as never,
  );
});

describe("deriveTexts — skip-not-fail (FR-15.13, DR-9.14)", () => {
  it("produces every asked-for derivative on the happy path — and no row for what was not asked", async () => {
    const { texts, outcomes } = await deriveTexts(env, db, ctxWith(), article);
    expect(texts.xVersion).toBe("tiny post");
    expect(texts.linkedinVersion).toBe("tiny post");
    expect(outcomes).toEqual([
      { kind: "x", outcome: "produced", content: "tiny post" },
      { kind: "linkedin", outcome: "produced", content: "tiny post" },
    ]);
    // translation off in the profile → absent, not skipped (design §5)
    expect(outcomes.some((o) => o.kind === "translation")).toBe(false);
  });

  it("records a channel not in profile.channels as nothing at all", async () => {
    const { outcomes } = await deriveTexts(env, db, ctxWith({ channels: ["x"] }), article);
    expect(outcomes.map((o) => o.kind)).toEqual(["x"]);
  });

  it("SKIPS an optional derivative whose capability is disabled, and continues", async () => {
    runTaskMock.mockImplementation(async (_e, _d, args) => {
      if (args.taskType === "shorten_x") throw new NoRouteError("shorten_x");
      return { text: "tiny post" } as never;
    });
    const { texts, outcomes } = await deriveTexts(env, db, ctxWith(), article);
    expect(texts.xVersion).toBeUndefined();
    expect(outcomes.find((o) => o.kind === "x")).toMatchObject({
      outcome: "skipped",
      reason: expect.stringContaining("no enabled route"),
    });
    expect(outcomes.find((o) => o.kind === "linkedin")).toMatchObject({ outcome: "produced" });
  });

  it("marks an attempted-but-failing derivative FAILED with the reason, and continues", async () => {
    runTaskMock.mockImplementation(async (_e, _d, args) => {
      if (args.taskType === "shorten_linkedin") throw new Error("provider exploded");
      return { text: "tiny post" } as never;
    });
    const { outcomes } = await deriveTexts(env, db, ctxWith(), article);
    expect(outcomes.find((o) => o.kind === "linkedin")).toMatchObject({
      outcome: "failed",
      reason: "provider exploded",
    });
    expect(outcomes.find((o) => o.kind === "x")).toMatchObject({ outcome: "produced" });
  });

  it("marks a REQUESTED translation failed — never silently dropped — when unroutable", async () => {
    runTaskMock.mockImplementation(async (_e, _d, args) => {
      if (args.taskType === "translate") throw new NoRouteError("translate");
      return { text: "tiny post" } as never;
    });
    const ctx = ctxWith({ translation: { enabled: true, targetLanguage: "ar" } });
    const { texts, outcomes } = await deriveTexts(env, db, ctx, article);
    expect(texts.translatedMarkdown).toBeUndefined();
    expect(outcomes.find((o) => o.kind === "translation")).toMatchObject({
      outcome: "failed",
      reason: expect.stringContaining("no enabled route"),
    });
  });

  it("produces the translation with the second document's metadata when routable", async () => {
    const ctx = ctxWith({ translation: { enabled: true, targetLanguage: "ar" } });
    const { texts, outcomes } = await deriveTexts(env, db, ctx, article);
    expect(texts.translatedMarkdown).toBe("# مرحبا");
    expect(outcomes.find((o) => o.kind === "translation")).toMatchObject({
      outcome: "produced",
      content: "# مرحبا",
      meta: { title: "عنوان", excerpt: "ملخص", imageAlt: "وصف", targetLanguage: "ar" },
    });
  });

  it("lets a GateError halt the step — pauses and caps are not derivative failures (FR-15.12a)", async () => {
    runTaskMock.mockRejectedValue(new GateError("ai_paused", "AI is paused by an administrator"));
    await expect(deriveTexts(env, db, ctxWith(), article)).rejects.toThrow(GateError);
  });
});
