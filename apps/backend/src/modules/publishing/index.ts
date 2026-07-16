// Bounded context: publishing (AR-10.2) — Sanity draft creation, publish, retract.
// Content truth lives in Sanity; this DB keeps pointers only (DR-9.6).
import { eq } from "drizzle-orm";
import type { Profile } from "@post-automate/shared";
import { schema, type Db } from "../../db/client";
import type { Env } from "../../shared/env";
import { generateHeroImage, type Article, type DerivedTexts } from "../generation";
import { mapForProject, type MapperInput } from "./mappers";
import {
  deleteDraft,
  getDocument,
  mutate,
  publishDraft as publishSanityDraft,
  retractPublished,
  uploadImageAsset,
  type SanityTarget,
} from "./sanity";

export { deleteDraft, retractPublished };

export interface PublishTargetUser {
  id: string;
  sanityProjectId: string | null;
  sanityDataset: string;
}

function targetOf(user: PublishTargetUser): SanityTarget {
  if (!user.sanityProjectId) {
    throw new Error(`User ${user.id} has no sanity_project_id — set it on the user record (FR-8.5)`);
  }
  return { projectId: user.sanityProjectId, dataset: user.sanityDataset };
}

export function sanityDraftId(runId: string): string {
  return `drafts.postauto-${runId}`; // deterministic → retried steps can't duplicate (AR-10.3)
}

/**
 * Create the reviewable Sanity draft (FR-8.1..8.3, FR-6.13): generates the hero image,
 * uploads it, maps article+derivatives through the per-site mapper, writes drafts.*,
 * and points the drafts row at it. Image bytes stay inside this call.
 */
export async function createSanityDraft(
  env: Env,
  db: Db,
  args: {
    user: PublishTargetUser;
    profile: Profile;
    runId: string;
    draftId: string; // drafts table row
    article: Article;
    texts: DerivedTexts;
    sourceUrls: string[];
    provider: string;
    model: string;
    blogType?: "public" | "em";
  },
): Promise<{ sanityDocId: string; imageAssetId?: string }> {
  const target = targetOf(args.user);

  let imageAssetId: string | undefined;
  try {
    const hero = await generateHeroImage(env, db, { userId: args.user.id, runId: args.runId, profile: args.profile }, args.article);
    imageAssetId = await uploadImageAsset(env, target, hero.imageBase64, hero.mimeType, `${args.article.slug}-hero.png`);
  } catch (e) {
    // A missing hero image should not kill the run — the reviewer sees it's absent (FR-6.13
    // is satisfied on revise/regenerate); the failure is already in ai_health_checks.
    console.warn("hero image generation/upload failed — draft continues without image:", e instanceof Error ? e.message : e);
  }

  const input: MapperInput = {
    article: args.article,
    texts: args.texts,
    profile: args.profile,
    runId: args.runId,
    provider: args.provider,
    model: args.model,
    imageAssetId,
    blogType: args.blogType,
  };
  const doc = mapForProject(target.projectId, input);
  (doc.generationMeta as { sourceUrls: string[] }).sourceUrls = args.sourceUrls;

  const sanityDocId = sanityDraftId(args.runId);
  await mutate(env, target, [{ createOrReplace: { ...doc, _id: sanityDocId } }]);
  await db.update(schema.drafts).set({ sanityDocumentId: sanityDocId }).where(eq(schema.drafts.id, args.draftId));
  return { sanityDocId, imageAssetId };
}

/** Approval → live (FR-7.5): refresh the date field, then publish. Production only (FR-8.5). */
export async function publishApprovedDraft(
  env: Env,
  db: Db,
  args: { user: PublishTargetUser; draftId: string },
): Promise<string> {
  const target = targetOf(args.user);
  const row = await db.query.drafts.findFirst({ where: eq(schema.drafts.id, args.draftId) });
  if (!row?.sanityDocumentId) throw new Error(`Draft ${args.draftId} has no Sanity document`);

  const dateField = target.projectId === "5gz3ngjs" ? "publishDate" : "datePublished";
  const doc = await getDocument(env, target, row.sanityDocumentId);
  if (doc) {
    await mutate(env, target, [
      { patch: { id: row.sanityDocumentId, set: { [dateField]: new Date().toISOString() } } },
    ]);
  }
  const publishedId = await publishSanityDraft(env, target, row.sanityDocumentId);
  await db
    .update(schema.drafts)
    .set({ status: "published", sanityDocumentId: publishedId, markdown: null, decidedAt: new Date() }) // DR-9.11 purge
    .where(eq(schema.drafts.id, args.draftId));
  return publishedId;
}
