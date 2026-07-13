import { Hono } from "hono";
import type { Env } from "../shared/env";
import { notImplemented } from "./stub";

// FR-8.6: Sanity webhook — HMAC-verified (SANITY_WEBHOOK_SECRET). Publish confirmations
// drive the run state machine; Studio edits are diffed into edit_diffs. Phase 4.
export const webhooks = new Hono<{ Bindings: Env }>().post("/sanity", notImplemented);
