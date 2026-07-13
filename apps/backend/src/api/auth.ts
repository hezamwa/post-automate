import { Hono } from "hono";
import type { Env } from "../shared/env";
import { notImplemented } from "./stub";

// FR-2.2: JWT login/refresh (PBKDF2 via WebCrypto; refresh tokens stored hashed). Phase 2.
export const auth = new Hono<{ Bindings: Env }>()
  .post("/login", notImplemented)
  .post("/refresh", notImplemented);
