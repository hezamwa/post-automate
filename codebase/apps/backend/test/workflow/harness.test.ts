import { beforeEach, describe, expect, it } from "vitest";
import { shared, resetShared, env } from "./preamble";
import { createDb } from "../../src/db/client";
import { runTask } from "../../src/ai/router";
import { sendFcmPush } from "../../src/shared/fcm";

describe("preamble mocks apply when imported first", () => {
  beforeEach(resetShared);
  it("createDb returns the PGlite db, router and fcm are faked", async () => {
    expect(createDb(env)).toBe(shared.db);
    shared.step.current = "probe";
    const r = await runTask(env, shared.db, { taskType: "scoring", userId: null, input: { messages: [] } });
    expect(r.parsed).toMatchObject({ scores: expect.any(Array) });
    expect(shared.step.billedTasks("probe")).toEqual(["scoring"]);
    expect(await sendFcmPush(env, "tok", { title: "t", body: "b" })).toBe(true);
    expect(shared.pushes).toHaveLength(1);
  });
});
