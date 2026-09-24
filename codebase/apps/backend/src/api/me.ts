import { Hono } from "hono";
import { requireAuth, type AuthedEnv } from "../auth/middleware";
import { createDb } from "../db/client";
import { myData } from "../db/my-data";

// FR-3.15: "My data" — read-only. Deletion stays an admin action (FR-2.6).
export const me = new Hono<AuthedEnv>()
  .use("*", requireAuth)
  .get("/data", async (c) => {
    const data = await myData(createDb(c.env), c.get("userId"));
    if (!data) return c.json({ error: "user not found" }, 404);
    return c.json(data);
  });
