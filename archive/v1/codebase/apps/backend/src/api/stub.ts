import type { Context } from "hono";

export const notImplemented = (c: Context) =>
  c.json({ error: "Not implemented yet — see docs/design.md §7 and the phase plan (§12)" }, 501);
