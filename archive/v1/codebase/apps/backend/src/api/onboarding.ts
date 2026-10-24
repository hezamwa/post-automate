import { Hono } from "hono";
import type { Env } from "../shared/env";
import { notImplemented } from "./stub";

// FR-4.x: structured interview (server merges partial profile each turn). Phase 3.
export const onboarding = new Hono<{ Bindings: Env }>()
  .post("/turn", notImplemented)
  .post("/confirm", notImplemented);
