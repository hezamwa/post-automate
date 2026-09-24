import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { GateError } from "../ai/gates";
import { requireAuth, type AuthedEnv } from "../auth/middleware";
import { createDb, schema } from "../db/client";
import { postChannel } from "../modules/social/post";
import { postView } from "../modules/social/records";

// Design §7 POST /drafts/:id/social/:channel (FR-18.3, FR-18.5): the confirm tap and the
// retry are the same call — it posts only what is missing for that channel.
export const draftSocial = new Hono<AuthedEnv>()
  .use("*", requireAuth)
  .post("/:id/social/:channel", async (c) => {
    const channel = c.req.param("channel");
    if (channel !== "x" && channel !== "linkedin") return c.json({ error: "unknown channel — x or linkedin" }, 404);
    const db = createDb(c.env);
    const draft = await db.query.drafts.findFirst({
      where: and(eq(schema.drafts.id, c.req.param("id")), eq(schema.drafts.userId, c.get("userId"))),
    });
    if (!draft) return c.json({ error: "draft not found" }, 404);
    if (draft.status !== "published") return c.json({ error: `the article is ${draft.status} — only a published article can be posted` }, 409);
    try {
      const row = await postChannel(c.env, db, { draftId: draft.id, channel });
      return c.json({ post: postView(row) });
    } catch (e) {
      if (e instanceof GateError) return c.json({ error: e.message }, 503);
      return c.json({ error: e instanceof Error ? e.message : "posting failed" }, 409);
    }
  });
