import { and, count, eq, gte, sql } from "drizzle-orm";
import type { ProviderId, TaskType } from "@post-automate/shared";
import { schema, type Db } from "../db/client";
import { MODEL_REGISTRY } from "./registry";
import type { Usage } from "./types";

// Per-call cost computation → spend_ledger (FR-15.7, design §10). Prices come from
// MODEL_REGISTRY; unpriced usage is a hard error so cost tracking can never silently
// undercount.

export function priceUsage(provider: ProviderId, model: string, usage: Usage): number {
  const info = MODEL_REGISTRY.find((m) => m.provider === provider && m.model === model);
  if (!info) {
    throw new Error(
      `Model ${provider}/${model} is not in the registry — add it with unit prices before routing to it (FR-15.4)`,
    );
  }
  let cost = 0;
  const need = (price: number | undefined, unit: string): number => {
    if (price == null) {
      throw new Error(`No ${unit} price for ${provider}/${model} in the registry (FR-15.4)`);
    }
    return price;
  };
  if (usage.inputTokens) cost += (usage.inputTokens / 1e6) * need(info.inputPerMTokUsd, "input-token");
  if (usage.outputTokens) cost += (usage.outputTokens / 1e6) * need(info.outputPerMTokUsd, "output-token");
  if (usage.searches) cost += usage.searches * need(info.perSearchUsd, "per-search");
  if (usage.images) cost += usage.images * need(info.perImageUsd, "per-image");
  return cost;
}

export async function recordSpend(
  db: Db,
  args: {
    userId: string | null;
    runId?: string | null;
    taskType: TaskType;
    provider: ProviderId;
    model: string;
    usage: Usage;
  },
): Promise<number> {
  const cost = priceUsage(args.provider, args.model, args.usage);
  await db.insert(schema.spendLedger).values({
    userId: args.userId,
    runId: args.runId ?? null,
    taskType: args.taskType,
    provider: args.provider,
    model: args.model,
    units: args.usage,
    estCostUsd: cost.toFixed(6),
  });
  return cost;
}

function monthStartUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Month-to-date spend. userId omitted/undefined = global (all users + system). */
export async function monthToDateUsd(db: Db, userId?: string): Promise<number> {
  const conditions = [gte(schema.spendLedger.createdAt, monthStartUtc())];
  if (userId) conditions.push(eq(schema.spendLedger.userId, userId));
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.spendLedger.estCostUsd}), 0)` })
    .from(schema.spendLedger)
    .where(and(...conditions));
  return Number(row?.total ?? 0);
}

/** AI calls by this user in the last `seconds` — the FR-15.8 per-minute rate gate. */
export async function recentCallCount(db: Db, userId: string, seconds: number): Promise<number> {
  const since = new Date(Date.now() - seconds * 1000);
  const [row] = await db
    .select({ n: count() })
    .from(schema.spendLedger)
    .where(and(eq(schema.spendLedger.userId, userId), gte(schema.spendLedger.createdAt, since)));
  return row?.n ?? 0;
}
