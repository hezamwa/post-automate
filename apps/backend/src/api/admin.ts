import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { PROVIDERS, TASK_TYPES } from "@post-automate/shared";
import { requireAdmin, type AuthedEnv } from "../auth/middleware";
import { testRoute } from "../ai/health";
import { monthToDateUsd } from "../ai/meter";
import { MODEL_REGISTRY } from "../ai/registry";
import { createDb, schema } from "../db/client";
import { deleteUserCascade, reactivateUser, suspendUser, upsertUserLimits } from "../db/commands";
import { latestHealthByRoute, listRoutes, monitorSnapshot, recentHealthChecks } from "../db/queries";
import { projectMonthEndUsd } from "../shared/budget";
import { describeFlags, flagAudit, FLAGS, getFlags, setFlag, type FlagKey } from "../shared/flags";
import { hashPassword } from "../shared/password";

// FR-15.4: routes may only point at registered models — validation + pricing live there.
function modelKnown(provider: string, model: string): boolean {
  return MODEL_REGISTRY.some((m) => m.provider === provider && m.model === model);
}

const routeBodySchema = z
  .object({
    userId: z.string().uuid().nullish(), // null/absent = global default (FR-15.3)
    taskType: z.enum(TASK_TYPES),
    priority: z.number().int().min(0).default(0),
    provider: z.enum(PROVIDERS),
    model: z.string().min(1),
    params: z.record(z.unknown()).default({}),
    enabled: z.boolean().default(true),
  })
  .strict();

const routePatchSchema = z
  .object({
    provider: z.enum(PROVIDERS).optional(),
    model: z.string().min(1).optional(),
    priority: z.number().int().min(0).optional(),
    params: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const limitsPatchSchema = z
  .object({
    monthlyCapUsd: z.number().positive().optional(),
    maxRunsPerDay: z.number().int().positive().optional(),
    maxReqPerMin: z.number().int().positive().optional(),
  })
  .strict();

function tempPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Design §7 admin routes — all require role=admin (FR-2.5). Serves the admin web dashboard (§15).
export const admin = new Hono<AuthedEnv>()
  .use("*", requireAdmin)

  // FR-15.11: one active monitoring surface — spend, caps, pipeline, route health, switches
  .get("/monitor", async (c) => {
    const db = createDb(c.env);
    const [snapshot, flags, routeHealth] = [
      await monitorSnapshot(db),
      await describeFlags(db),
      await latestHealthByRoute(db),
    ];
    const capUsd = (await getFlags(db))["global_monthly_cap_usd"];
    return c.json({
      ...snapshot,
      globalCap: { capUsd, spentUsd: snapshot.spend.monthToDateUsd, percentUsed: Number(((snapshot.spend.monthToDateUsd / capUsd) * 100).toFixed(1)) },
      switches: flags, // §10.1: current state of every switch, with who set it and when
      routeHealth,
    });
  })

  // FR-15.10: view the global hard cap with consumption + a linear month-end projection
  .get("/budget", async (c) => {
    const db = createDb(c.env);
    const capUsd = (await getFlags(db))["global_monthly_cap_usd"];
    const spentUsd = await monthToDateUsd(db);
    return c.json({
      capUsd,
      spentUsd: Number(spentUsd.toFixed(4)),
      percentUsed: Number(((spentUsd / capUsd) * 100).toFixed(1)),
      projectedMonthEndUsd: Number(projectMonthEndUsd(spentUsd, new Date()).toFixed(2)),
    });
  })
  // Raising a cap deserves a trail too (DR-9.13) — the write goes through the flag store.
  .patch("/budget", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { capUsd?: unknown };
    try {
      await setFlag(createDb(c.env), "global_monthly_cap_usd", body.capUsd as number, c.get("userId"));
    } catch (e) {
      if (e instanceof z.ZodError) {
        return c.json({ error: `Invalid capUsd: ${e.issues[0]?.message ?? "must be a positive number"}` }, 400);
      }
      throw e;
    }
    return c.json({ ok: true, capUsd: body.capUsd });
  })

  // FR-15.14: current value + default + last change (who/when) for every declared flag
  .get("/flags", async (c) => c.json({ flags: await describeFlags(createDb(c.env)) }))
  .get("/flags/audit", async (c) => c.json({ audit: await flagAudit(createDb(c.env)) })) // DR-9.13
  // FR-15.12: flip one switch — validated against the declared schema, audited
  .patch("/flags/:key", async (c) => {
    const key = c.req.param("key");
    if (!(key in FLAGS)) {
      return c.json({ error: `Unknown flag '${key}' — declared flags: ${Object.keys(FLAGS).join(", ")} (FR-15.14)` }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
    const db = createDb(c.env);
    try {
      await setFlag(db, key as FlagKey, body.value as never, c.get("userId"));
    } catch (e) {
      if (e instanceof z.ZodError) {
        return c.json({ error: `Invalid value for '${key}': ${e.issues[0]?.message ?? "wrong type"}` }, 400);
      }
      throw e;
    }
    const described = (await describeFlags(db)).find((f) => f.key === key);
    return c.json({ ok: true, flag: described });
  })
  // ── AI routing CRUD (FR-15.3): global defaults + per-user overrides, no redeploy ──
  .get("/ai/routes", async (c) => c.json({ routes: await listRoutes(createDb(c.env)) }))
  .post("/ai/routes", async (c) => {
    const parsed = routeBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const body = parsed.data;
    if (!modelKnown(body.provider, body.model)) {
      return c.json({ error: `Model '${body.model}' is not registered for ${body.provider} — add it to the model registry with unit prices first (FR-15.4).` }, 400);
    }
    const db = createDb(c.env);
    try {
      const [row] = await db
        .insert(schema.aiRoutes)
        .values({ ...body, userId: body.userId ?? null, version: 1 })
        .returning();
      return c.json({ route: row }, 201);
    } catch (e) {
      if (e instanceof Error && /ai_routes_user_task_priority|duplicate/i.test(e.message)) {
        return c.json({ error: `A route already exists for this (user, taskType, priority) — PATCH it instead (FR-15.3).` }, 409);
      }
      throw e;
    }
  })
  .patch("/ai/routes/:id", async (c) => {
    const parsed = routePatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const patch = parsed.data;
    const db = createDb(c.env);
    const route = await db.query.aiRoutes.findFirst({ where: eq(schema.aiRoutes.id, c.req.param("id")) });
    if (!route) return c.json({ error: "route not found" }, 404);
    const provider = patch.provider ?? (route.provider as (typeof PROVIDERS)[number]);
    const model = patch.model ?? route.model;
    if ((patch.provider || patch.model) && !modelKnown(provider, model)) {
      return c.json({ error: `Model '${model}' is not registered for ${provider} — add it to the model registry with unit prices first (FR-15.4).` }, 400);
    }
    const [row] = await db
      .update(schema.aiRoutes)
      // version increments in place; generationMeta pinned the version active at generation time (design §6.2)
      .set({ ...patch, version: route.version + 1, updatedAt: new Date() })
      .where(eq(schema.aiRoutes.id, route.id))
      .returning();
    return c.json({ route: row });
  })

  // FR-15.5: canary-test THIS route (never its fallbacks); explicitly admin-triggered,
  // so it bypasses ai.paused and the global cap by design (§10.1)
  .post("/ai/routes/:id/test", async (c) => {
    const result = await testRoute(c.env, createDb(c.env), c.req.param("id"));
    if (!result) return c.json({ error: "route not found" }, 404);
    return c.json({ result });
  })
  .get("/ai/health", async (c) => {
    const db = createDb(c.env);
    return c.json({ routes: await latestHealthByRoute(db), history: await recentHealthChecks(db) });
  })

  // ── users (FR-2.5/2.6): data, never code ─────────────────────────────────────────
  .get("/users", async (c) => {
    const rows = await createDb(c.env)
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        role: schema.users.role,
        sanityProjectId: schema.users.sanityProjectId,
        sanityDataset: schema.users.sanityDataset,
        autoPublish: schema.users.autoPublish,
        suspendedAt: schema.users.suspendedAt,
        suspendedReason: schema.users.suspendedReason,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .orderBy(asc(schema.users.createdAt));
    return c.json({ users: rows });
  })
  .post("/users", async (c) => {
    const bodySchema = z
      .object({
        email: z.string().email(),
        displayName: z.string().min(1),
        role: z.enum(["user", "admin"]).default("user"),
        sanityProjectId: z.string().min(1).optional(),
        sanityDataset: z.string().min(1).default("production"),
      })
      .strict();
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const db = createDb(c.env);
    const password = tempPassword();
    try {
      const [row] = await db
        .insert(schema.users)
        .values({
          email: parsed.data.email,
          displayName: parsed.data.displayName,
          role: parsed.data.role,
          sanityProjectId: parsed.data.sanityProjectId ?? null,
          sanityDataset: parsed.data.sanityDataset,
          autoPublish: false, // approval for everyone initially (OD-4)
          passwordHash: await hashPassword(password),
        })
        .returning({ id: schema.users.id, email: schema.users.email });
      await db.insert(schema.userLimits).values({ userId: row!.id }).onConflictDoNothing(); // FR-15.8 defaults
      // shown exactly once — never logged, never retrievable again (NFR-11.7)
      return c.json({ user: row, tempPassword: password }, 201);
    } catch (e) {
      if (e instanceof Error && /users_email_unique|duplicate/i.test(e.message)) {
        return c.json({ error: "a user with this email already exists" }, 409);
      }
      throw e;
    }
  })
  // FR-2.6 right to erasure — personal rows cascade, spend anonymizes, published content
  // stays (an editorial decision, not an automatic one)
  .delete("/users/:id", async (c) => {
    const id = c.req.param("id");
    if (id === c.get("userId")) return c.json({ error: "You cannot delete your own account." }, 400);
    const db = createDb(c.env);
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, id) });
    if (!user) return c.json({ error: "user not found" }, 404);
    try {
      const { anonymizedSpendRows } = await deleteUserCascade(db, id);
      return c.json({ ok: true, anonymizedSpendRows });
    } catch (e) {
      if (e instanceof Error && e.message.includes("app_config_audit")) {
        return c.json({ error: e.message }, 409);
      }
      throw e;
    }
  })

  // FR-2.7: reversible suspend — an account state, never a $0 cap.
  .post("/users/:id/suspend", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    if (!body.reason || typeof body.reason !== "string") {
      return c.json({ error: "Body must include { reason } — suspensions carry a human-readable reason (FR-2.7)." }, 400);
    }
    const id = c.req.param("id");
    if (id === c.get("userId")) {
      return c.json({ error: "You cannot suspend your own account." }, 400);
    }
    const db = createDb(c.env);
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, id) });
    if (!user) return c.json({ error: "user not found" }, 404);
    if (user.suspendedAt) {
      return c.json(
        { error: `Already suspended since ${user.suspendedAt.toISOString()} (${user.suspendedReason ?? "no reason recorded"}). Reactivate first to change the reason.` },
        409,
      );
    }
    await suspendUser(db, id, body.reason);
    return c.json({ ok: true, suspended: true });
  })
  .delete("/users/:id/suspend", async (c) => {
    const id = c.req.param("id");
    const db = createDb(c.env);
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, id) });
    if (!user) return c.json({ error: "user not found" }, 404);
    if (!user.suspendedAt) return c.json({ error: "user is not suspended" }, 409);
    await reactivateUser(db, id);
    return c.json({ ok: true, suspended: false });
  })

  // ── per-user caps (FR-15.8, OD-16 defaults) ──────────────────────────────────────
  .get("/users/:id/limits", async (c) => {
    const db = createDb(c.env);
    const userId = c.req.param("id");
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
    if (!user) return c.json({ error: "user not found" }, 404);
    const row = await db.query.userLimits.findFirst({ where: eq(schema.userLimits.userId, userId) });
    const limits = {
      monthlyCapUsd: Number(row?.monthlyCapUsd ?? 10),
      maxRunsPerDay: row?.maxRunsPerDay ?? 2,
      maxReqPerMin: row?.maxReqPerMin ?? 30,
    };
    return c.json({ userId, limits, spentUsd: Number((await monthToDateUsd(db, userId)).toFixed(4)), isDefault: !row });
  })
  .patch("/users/:id/limits", async (c) => {
    const parsed = limitsPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const db = createDb(c.env);
    const userId = c.req.param("id");
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
    if (!user) return c.json({ error: "user not found" }, 404);
    await upsertUserLimits(db, userId, parsed.data);
    const row = await db.query.userLimits.findFirst({ where: eq(schema.userLimits.userId, userId) });
    return c.json({
      ok: true,
      limits: { monthlyCapUsd: Number(row!.monthlyCapUsd), maxRunsPerDay: row!.maxRunsPerDay, maxReqPerMin: row!.maxReqPerMin },
    });
  });
