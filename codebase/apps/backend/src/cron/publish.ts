import { and, eq, lte } from "drizzle-orm";
import { schema, type Db } from "../db/client";
import { getUserById, setRunState } from "../db/commands";
import { publishApprovedDraft } from "../modules/publishing";
import type { Env } from "../shared/env";
import { getFlags } from "../shared/flags";

/** Hourly — publish scheduled drafts whose slot has arrived (FR-7.5). */
export async function hourlyPublish(env: Env, db: Db): Promise<void> {
  const due = await db
    .select()
    .from(schema.drafts)
    .where(and(eq(schema.drafts.status, "scheduled"), lte(schema.drafts.publishAt, new Date())));
  // publishApprovedDraft is the authoritative publishing.paused check (FR-15.12b); this
  // early exit only keeps a deliberate pause from logging as per-draft FAILURES each hour.
  if (due.length > 0 && (await getFlags(db))["publishing.paused"]) {
    console.log(`publisher: publishing.paused — ${due.length} due draft(s) held, will publish once resumed`);
    return;
  }
  for (const draft of due) {
    try {
      const user = await getUserById(db, draft.userId);
      await publishApprovedDraft(env, db, { user, draftId: draft.id }); // production-only (FR-8.5)
      await setRunState(db, draft.runId, "published");
      console.log("publisher: published", { draftId: draft.id });
    } catch (e) {
      console.error("publisher: failed", draft.id, e instanceof Error ? e.message : e);
    }
  }
}
