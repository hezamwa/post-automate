import { Hono } from "hono";
import type { Env } from "../shared/env";
import { notImplemented } from "./stub";

// Design §7: run history + triggers. /trigger is Phase 1's manual entry point.
export const runs = new Hono<{ Bindings: Env }>()
  .get("/", notImplemented)
  .post("/trigger", notImplemented) // manual run (Phase 1)
  // {title, notes?, links[]?, overrideBannedTopics?} — user-requested topic (FR-5.8, FR-7.7)
  .post("/request", notImplemented)
  .post("/:id/angle", notImplemented); // {angleIndex} → angle-choice event (FR-6.3)
