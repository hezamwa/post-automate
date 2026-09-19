import { Hono } from "hono";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { CAPABILITIES, PROVIDERS, TASK_TYPES } from "@post-automate/shared";
import { requireAdmin, type AuthedEnv } from "../auth/middleware";
import { getAdapter } from "../ai/adapters";
import { testRoute } from "../ai/health";
import { monthToDateUsd } from "../ai/meter";
import { routeRejection } from "@post-automate/shared";
import { createDb, schema } from "../db/client";
import {
  deleteRouteCascade,
  deleteUserCascade,
  reactivateUser,
  reorderRoutes,
  suspendUser,
  upsertUserLimits,
} from "../db/commands";
import {
  latestHealthByRoute,
  listModels,
  listRoutes,
  monitorSnapshot,
  recentHealthChecks,
  routesUsingModel,
} from "../db/queries";
import { projectMonthEndUsd } from "../shared/budget";
import { describeFlags, flagAudit, FLAGS, getFlags, setFlag, type FlagKey } from "../shared/flags";
import { hashPassword } from "../shared/password";

// FR-15.4/15.2: a route may only point at a registered model that can actually serve its
// task. routeRejection() is the shared rule the admin dashboard builds its picker from, so
// the UI cannot offer a combination this endpoint would refuse.

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

type PriceInput = {
  inputPerMTokUsd?: number | null;
  outputPerMTokUsd?: number | null;
  perImageUsd?: number | null;
  perSearchUsd?: number | null;
};
type PriceColumns = { [K in keyof PriceInput]: string | null };

/**
 * Prices cross the wire as numbers; the numeric columns take strings. An omitted field is
 * left alone (PATCH semantics), an explicit null clears the price — which makes the model
 * unroutable again rather than free.
 */
function toPriceColumns(body: PriceInput): PriceColumns {
  const out: PriceColumns = {};
  for (const key of ["inputPerMTokUsd", "outputPerMTokUsd", "perImageUsd", "perSearchUsd"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    out[key] = value === null ? null : String(value);
  }
  return out;
}

const priceFields = {
  inputPerMTokUsd: z.number().nonnegative().nullish(),
  outputPerMTokUsd: z.number().nonnegative().nullish(),
  perImageUsd: z.number().nonnegative().nullish(),
  perSearchUsd: z.number().nonnegative().nullish(),
  notes: z.string().max(500).nullish(),
};

const modelBodySchema = z
  .object({
    provider: z.enum(PROVIDERS),
    model: z.string().min(1).max(200),
    capability: z.enum(CAPABILITIES),
    ...priceFields,
  })
  .strict();

const modelPatchSchema = z.object({ capability: z.enum(CAPABILITIES).optional(), ...priceFields }).strict();

const reorderSchema = z
  .object({ orderedIds: z.array(z.string().uuid()).min(1) })
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
    const db = createDb(c.env);
    const rejection = routeRejection(await listModels(db), body.provider, body.model, body.taskType);
    if (rejection) return c.json({ error: rejection }, 400);
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
    if (patch.provider || patch.model) {
      // taskType is immutable on a route, so the existing one is what we validate against
      const rejection = routeRejection(await listModels(db), provider, model, route.taskType as (typeof TASK_TYPES)[number]);
      if (rejection) return c.json({ error: rejection }, 400);
    }
    const [row] = await db
      .update(schema.aiRoutes)
      // version increments in place; generationMeta pinned the version active at generation time (design §6.2)
      .set({ ...patch, version: route.version + 1, updatedAt: new Date() })
      .where(eq(schema.aiRoutes.id, route.id))
      .returning();
    return c.json({ route: row });
  })

  // FR-15.3: remove a route outright. Disabling leaves a wrong route in the table forever;
  // the dashboard needs a way to undo a mistake, and the last enabled route for a task
  // disappearing is the documented way to turn a capability off (FR-15.13).
  .delete("/ai/routes/:id", async (c) => {
    const db = createDb(c.env);
    const route = await db.query.aiRoutes.findFirst({ where: eq(schema.aiRoutes.id, c.req.param("id")) });
    if (!route) return c.json({ error: "route not found" }, 404);
    const { healthChecksDeleted } = await deleteRouteCascade(db, route.id);
    return c.json({ ok: true, deleted: { id: route.id, healthChecksDeleted } });
  })

  // FR-15.6: fallback ORDER is the whole meaning of priority, so it gets a first-class
  // endpoint — renumbering by hand trips the (user, task, priority) unique index.
  .post("/ai/routes/reorder", async (c) => {
    const parsed = reorderSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const { orderedIds } = parsed.data;
    const db = createDb(c.env);
    const rows = await db.select().from(schema.aiRoutes).where(inArray(schema.aiRoutes.id, orderedIds));
    if (rows.length !== orderedIds.length) {
      return c.json({ error: "One or more of those routes no longer exists — reload and try again." }, 404);
    }
    // One ordering belongs to exactly one (scope, task) chain; mixing them would renumber
    // across chains and silently repoint traffic.
    const scopes = new Set(rows.map((r) => `${r.userId ?? "global"}:${r.taskType}`));
    if (scopes.size > 1) {
      return c.json({ error: "Those routes span more than one task or scope — reorder one chain at a time." }, 400);
    }
    const group = rows[0]!;
    const all = await db
      .select({ id: schema.aiRoutes.id })
      .from(schema.aiRoutes)
      .where(
        and(
          group.userId ? eq(schema.aiRoutes.userId, group.userId) : isNull(schema.aiRoutes.userId),
          eq(schema.aiRoutes.taskType, group.taskType),
        ),
      );
    if (all.length !== orderedIds.length) {
      return c.json(
        { error: "That ordering is missing some of the task's routes — send the whole chain, primary first." },
        400,
      );
    }
    await reorderRoutes(db, orderedIds);
    return c.json({ routes: await listRoutes(db) });
  })

  // ── Model registry CRUD (FR-15.4) ──────────────────────────────────────────────────
  // The registry became a table so a provider's model + prices can be added without a
  // deploy. Prices are what the budget gates are computed from, so they are written exactly
  // as given: a missing price stays NULL (routing refuses it) rather than defaulting to 0.
  .get("/ai/models", async (c) => c.json({ models: await listModels(createDb(c.env)) }))

  // The provider's OWN catalogue, fetched live (FR-15.4 registry assist): picking a model
  // from a real list beats typing an id from memory and finding out at the first call.
  // Deliberately not cached — a catalogue is only worth showing if it is current.
  .get("/ai/providers/:provider/models", async (c) => {
    const provider = c.req.param("provider");
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      return c.json({ error: `Unknown provider '${provider}'.` }, 400);
    }
    const adapter = getAdapter(provider as (typeof PROVIDERS)[number], c.env);
    if (!adapter.listModels) {
      return c.json({ error: `${provider} publishes no model listing — add its models by id.` }, 501);
    }
    try {
      return c.json({ models: await adapter.listModels() });
    } catch (e) {
      // A provider that is down, unpaid or misconfigured must say so in words the admin can
      // act on — never a bare 500 (FR-15.5's spirit).
      const { status, code } = (adapter.classifyError ?? (() => ({ status: "provider_error" as const, code: undefined })))(e);
      return c.json(
        {
          error: `Could not list ${provider} models (${status}${code ? `, HTTP ${code}` : ""}): ${
            e instanceof Error ? e.message.slice(0, 300) : "unknown error"
          }`,
        },
        502,
      );
    }
  })
  .post("/ai/models", async (c) => {
    const parsed = modelBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const body = parsed.data;
    const db = createDb(c.env);
    try {
      const [row] = await db
        .insert(schema.aiModels)
        .values({
          provider: body.provider,
          model: body.model,
          capability: body.capability,
          notes: body.notes ?? null,
          ...toPriceColumns(body),
        })
        .returning();
      return c.json({ model: row }, 201);
    } catch (e) {
      if (e instanceof Error && /ai_models_provider_model|duplicate/i.test(e.message)) {
        return c.json({ error: `${body.provider}/${body.model} is already registered — edit it instead.` }, 409);
      }
      throw e;
    }
  })
  .patch("/ai/models/:id", async (c) => {
    const parsed = modelPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const db = createDb(c.env);
    const existing = await db.query.aiModels.findFirst({ where: eq(schema.aiModels.id, c.req.param("id")) });
    if (!existing) return c.json({ error: "model not found" }, 404);
    // Capability decides which routes are valid, so narrowing it could strand live routes.
    if (parsed.data.capability && parsed.data.capability !== existing.capability) {
      const inUse = await routesUsingModel(db, existing.provider, existing.model);
      if (inUse.length > 0) {
        return c.json(
          {
            error: `${existing.provider}/${existing.model} is routed for ${[...new Set(inUse.map((r) => r.taskType))].join(", ")} — delete those routes before changing its capability (FR-15.4).`,
          },
          409,
        );
      }
    }
    const [row] = await db
      .update(schema.aiModels)
      .set({
        ...(parsed.data.capability ? { capability: parsed.data.capability } : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
        ...toPriceColumns(parsed.data),
        updatedAt: new Date(),
      })
      .where(eq(schema.aiModels.id, existing.id))
      .returning();
    return c.json({ model: row });
  })
  .delete("/ai/models/:id", async (c) => {
    const db = createDb(c.env);
    const existing = await db.query.aiModels.findFirst({ where: eq(schema.aiModels.id, c.req.param("id")) });
    if (!existing) return c.json({ error: "model not found" }, 404);
    const inUse = await routesUsingModel(db, existing.provider, existing.model);
    if (inUse.length > 0) {
      return c.json(
        {
          error: `${existing.provider}/${existing.model} is still routed for ${[...new Set(inUse.map((r) => r.taskType))].join(", ")} — delete those routes first, or the registry would no longer describe what the router calls (FR-15.4).`,
        },
        409,
      );
    }
    await db.delete(schema.aiModels).where(eq(schema.aiModels.id, existing.id));
    return c.json({ ok: true, deleted: { provider: existing.provider, model: existing.model } });
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
