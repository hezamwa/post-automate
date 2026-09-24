import { count, desc, eq } from "drizzle-orm";
import { monthToDateUsd } from "../ai/meter";
import { schema, type Db } from "./client";

// "My data" (FR-3.15, design §7 /me/data): what the system stores about one user, read-only
// and owner-scoped. Never the password hash, never a token.

const RECENT = 50;

export async function myData(db: Db, userId: string) {
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) return null;

  const profileVersions = await db
    .select({ version: schema.profiles.version, status: schema.profiles.status, createdAt: schema.profiles.createdAt })
    .from(schema.profiles)
    .where(eq(schema.profiles.userId, userId))
    .orderBy(desc(schema.profiles.version));
  const gateChoices = await db
    .select({ gate: schema.gateChoices.gate, choice: schema.gateChoices.choice, freeText: schema.gateChoices.freeText, source: schema.gateChoices.source, chosenAt: schema.gateChoices.chosenAt })
    .from(schema.gateChoices)
    .where(eq(schema.gateChoices.userId, userId))
    .orderBy(desc(schema.gateChoices.chosenAt))
    .limit(RECENT);
  const editDiffs = await db
    .select({ draftId: schema.editDiffs.draftId, diff: schema.editDiffs.diff, createdAt: schema.editDiffs.createdAt })
    .from(schema.editDiffs)
    .where(eq(schema.editDiffs.userId, userId))
    .orderBy(desc(schema.editDiffs.createdAt))
    .limit(RECENT);
  const revisions = await db
    .select({ draftId: schema.draftRevisions.draftId, revisionNo: schema.draftRevisions.revisionNo, instructions: schema.draftRevisions.instructions, createdAt: schema.draftRevisions.createdAt })
    .from(schema.draftRevisions)
    .innerJoin(schema.drafts, eq(schema.drafts.id, schema.draftRevisions.draftId))
    .where(eq(schema.drafts.userId, userId))
    .orderBy(desc(schema.draftRevisions.createdAt))
    .limit(RECENT);
  const draftsByStatus = await db
    .select({ status: schema.drafts.status, n: count() })
    .from(schema.drafts)
    .where(eq(schema.drafts.userId, userId))
    .groupBy(schema.drafts.status);
  const limits = await db.query.userLimits.findFirst({ where: eq(schema.userLimits.userId, userId) });

  return {
    account: {
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      sanityProjectId: user.sanityProjectId,
      sanityDataset: user.sanityDataset,
      createdAt: user.createdAt,
      lastActiveAt: user.lastActiveAt,
    },
    profileVersions,
    gateChoices,
    editDiffs,
    revisions,
    draftsByStatus,
    spend: {
      monthToDateUsd: Number((await monthToDateUsd(db, userId)).toFixed(4)),
      monthlyCapUsd: Number(limits?.monthlyCapUsd ?? 10),
      maxRunsPerDay: limits?.maxRunsPerDay ?? 2,
      autoPublish: limits?.autoPublish ?? false,
    },
  };
}
