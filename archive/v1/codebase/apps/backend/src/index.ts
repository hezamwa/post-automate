import { Hono } from "hono";
import { cors } from "hono/cors";
import { api } from "./api";
import { dailyDispatch } from "./cron/dispatch";
import { hourlyPublish } from "./cron/publish";
import { createDb } from "./db/client";
import { backupSanityDatasets } from "./shared/backup";
import type { Env } from "./shared/env";

export { PipelineWorkflow } from "./workflows/pipeline";

const app = new Hono<{ Bindings: Env }>();
// CORS: exactly one origin — the Flutter web dev port (tools/run-web.sh) — so the web
// build can drive any environment while the app is run-from-source (2026-08-22; drop
// once the app ships natively or is hosted same-origin). Not a security boundary here:
// auth is Bearer-only (no cookies), so CORS only decides which browser pages may call.
app.use(
  "*",
  cors({
    origin: "http://localhost:8090",
    allowHeaders: ["authorization", "content-type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE"],
  }),
);
app.get("/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));
app.route("/", api);
// Never a bare 500: every refusal in this system is written to be shown to a human
// (FR-15.8's spirit) — surface the message so "operation failed" is diagnosable in-app.
app.onError((err, c) => {
  console.error(`unhandled route error [${c.req.method} ${c.req.path}]:`, err.message);
  return c.json({ error: err.message }, 500);
});

// Cron — production only (FR-8.5, spec §2). One job per file under src/cron.
export default {
  fetch: app.fetch,

  async scheduled(controller, env, ctx) {
    const db = createDb(env);
    switch (controller.cron) {
      case "0 6 * * *":
        ctx.waitUntil(dailyDispatch(env, db));
        break;
      case "0 * * * *":
        ctx.waitUntil(hourlyPublish(env, db));
        break;
      case "0 3 * * SUN": // weekly Sanity dataset export → R2 (NFR-16.3)
        ctx.waitUntil(backupSanityDatasets(env, db));
        break;
    }
  },
} satisfies ExportedHandler<Env>;
