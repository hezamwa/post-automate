import { vi } from "vitest";
import type { Env } from "../../src/shared/env";
import { createTestDb } from "../db/harness";
import { FakeStep } from "./fake-step";
import { FakeAi, type SharedState } from "./mocks";

// Import this FIRST in a workflow test file: it registers the module mocks (router,
// Sanity client, FCM, createDb → PGlite) before any src module loads, and owns the
// per-test state those mocks read. Call resetShared() in beforeEach.
//
// vi.mock calls are hoisted above the imports of THIS module; their factories run lazily,
// the first time a test imports the mocked module — by then `shared` exists.

export const shared: SharedState = {
  db: null as never,
  step: null as never,
  ai: null as never,
  sanity: { docs: new Map(), mutations: [] },
  pushes: [],
};

vi.mock("../../src/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/db/client")>()),
  createDb: () => shared.db,
}));
vi.mock("../../src/ai/router", async (importOriginal) =>
  (await import("./mocks")).routerMock(await importOriginal<typeof import("../../src/ai/router")>(), shared),
);
vi.mock("../../src/modules/publishing/sanity", async () => (await import("./mocks")).sanityMock(shared));
vi.mock("../../src/shared/fcm", async () => (await import("./mocks")).fcmMock(shared));

export const env = { ENVIRONMENT: "production" } as Env;

export async function resetShared(): Promise<void> {
  shared.db = await createTestDb();
  shared.step = new FakeStep();
  shared.ai = new FakeAi();
  shared.sanity.docs.clear();
  shared.sanity.mutations.length = 0;
  shared.pushes.length = 0;
}
