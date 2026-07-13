import { Hono } from "hono";
import type { Env } from "../shared/env";
import { notImplemented } from "./stub";

// Design §7 admin routes — all require role=admin (FR-2.5). Serves the admin web dashboard (§15).
export const admin = new Hono<{ Bindings: Env }>()
  .get("/monitor", notImplemented) // FR-15.11
  .get("/budget", notImplemented) // FR-15.10
  .patch("/budget", notImplemented)
  .get("/ai/routes", notImplemented) // FR-15.3
  .post("/ai/routes", notImplemented)
  .patch("/ai/routes/:id", notImplemented)
  .post("/ai/routes/:id/test", notImplemented) // FR-15.5 (bypasses global cap by design, §10)
  .get("/ai/health", notImplemented)
  .get("/users", notImplemented)
  .post("/users", notImplemented) // FR-2.5
  .delete("/users/:id", notImplemented) // FR-2.6 right to erasure
  .get("/users/:id/limits", notImplemented) // FR-15.8
  .patch("/users/:id/limits", notImplemented);
