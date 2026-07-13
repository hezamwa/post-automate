import { Hono } from "hono";
import { api } from "./api";
import type { Env } from "./shared/env";

export { PipelineWorkflow } from "./workflows/pipeline";

const app = new Hono<{ Bindings: Env }>();
app.get("/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));
app.route("/", api);

export default {
  fetch: app.fetch,

  async scheduled(controller, env, _ctx) {
    switch (controller.cron) {
      case "0 6 * * *":
        // Daily dispatcher (design §1): launch PIPELINE instances for users due today
        // (FR-3.6), re-test enabled AI routes (FR-15.5), purge expired onboarding
        // transcripts (OD-7). TODO(phase-1/4).
        break;
      case "0 * * * *":
        // Hourly publisher: publish drafts whose publish_at has arrived (FR-7.5). TODO(phase-2).
        break;
    }
    console.log("scheduled tick", controller.cron, env.ENVIRONMENT);
  },
} satisfies ExportedHandler<Env>;
