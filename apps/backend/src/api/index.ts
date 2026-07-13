import { Hono } from "hono";
import type { Env } from "../shared/env";
import { auth } from "./auth";
import { onboarding } from "./onboarding";
import { drafts } from "./drafts";
import { runs } from "./runs";
import { admin } from "./admin";
import { webhooks } from "./webhooks";

// Route map: design §7. All handlers are 501 stubs until their phase lands.
export const api = new Hono<{ Bindings: Env }>()
  .route("/auth", auth)
  .route("/onboarding", onboarding)
  .route("/drafts", drafts)
  .route("/runs", runs)
  .route("/admin", admin)
  .route("/webhooks", webhooks);
