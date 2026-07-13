import { Hono } from "hono";
import type { Env } from "../shared/env";
import { notImplemented } from "./stub";

// Design §7: drafts queue + decisions. Phase 2.
export const drafts = new Hono<{ Bindings: Env }>()
  .get("/", notImplemented)
  // {action: approve|reject|revise|change_angle, editedMarkdown?, publishMode?,
  //  instructions?, angleIndex?, rejectionCategory?} (FR-7.5, FR-7.8-7.9)
  .post("/:id/decision", notImplemented)
  .post("/:id/cancel-schedule", notImplemented) // FR-7.8
  .post("/:id/retract", notImplemented); // FR-7.6
