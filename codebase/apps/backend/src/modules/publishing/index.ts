// Bounded context: publishing (AR-10.2) — Sanity draft creation, publish, retract.
// Content truth lives in Sanity; this DB keeps pointers only (DR-9.6).
import { and, desc, eq } from "drizzle-orm";
import type { Profile } from "@post-automate/shared";
import { GateError } from "../../ai/gates";
import { NoRouteError } from "../../ai/router";
import { schema, type Db } from "../../db/client";
import { getFlags } from "../../shared/flags";
import type { Env } from "../../shared/env";
import { generateHeroImage, type Article, type DerivedTexts } from "../generation";
import {
  mapForProject,
  mapTranslatedForProject,
  translatedDocId,
  translationMetadataDoc,
  type MapperInput,
} from "./mappers";
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
    /** Revisions keep the existing hero unless instructions address it (FR-7.9). */
    existingImageAssetId?: string;
  },
): Promise<{
  sanityDocId: string;
  imageAssetId?: string;
  /** DR-9.14 outcome for the hero_image row — recorded by the pipeline's record step. */
  heroOutcome: { outcome: "produced" | "skipped" | "failed"; assetRef?: string; reason?: string };
}> {
  const target = targetOf(args.user);

  let imageAssetId = args.existingImageAssetId;
  // Revisions keep the image unless instructions address it (FR-7.9) — still `produced`.
  let heroOutcome: { outcome: "produced" | "skipped" | "failed"; assetRef?: string; reason?: string } =
    imageAssetId ? { outcome: "produced", assetRef: imageAssetId } : { outcome: "failed" };
  if (!imageAssetId) {
    try {
      const hero = await generateHeroImage(env, db, { userId: args.user.id, runId: args.runId, profile: args.profile }, args.article);
      imageAssetId = await uploadImageAsset(env, target, hero.imageBase64, hero.mimeType, `${args.article.slug}-hero.png`);
      heroOutcome = { outcome: "produced", assetRef: imageAssetId };
    } catch (e) {
      if (e instanceof GateError) throw e; // ai.paused/caps halt the step (FR-15.12a), not degrade
      // Skip-not-fail (FR-15.13): a missing hero image never kills the run — the reviewer
      // sees WHY it is absent (DR-9.14): capability disabled = skipped; tried and lost = failed.
      heroOutcome =
        e instanceof NoRouteError
          ? { outcome: "skipped", reason: "The 'image' capability is disabled — no enabled route (FR-15.13). Re-enable a route and revise the draft to generate it." }
          : { outcome: "failed", reason: e instanceof Error ? e.message.slice(0, 300) : "unknown error" };
      console.warn("hero image generation/upload failed — draft continues without image:", heroOutcome.reason);
    }
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
  return { sanityDocId, imageAssetId, heroOutcome };
}

/** Patch the article body on an existing Sanity draft (approve-with-edits, FR-6.9). */
export async function patchDraftMarkdown(
  env: Env,
  user: PublishTargetUser,
  sanityDocId: string,
  markdown: string,
): Promise<void> {
  const target = targetOf(user);
  const field = target.projectId === "5gz3ngjs" ? "body" : "content";
  const { markdownToPortableText } = await import("./portable-text");
  await mutate(env, target, [{ patch: { id: sanityDocId, set: { [field]: markdownToPortableText(markdown) } } }]);
}

/** Approval → live (FR-7.5): refresh the date field, then publish. Production only (FR-8.5). */
export async function publishApprovedDraft(
  env: Env,
  db: Db,
  args: { user: PublishTargetUser; draftId: string },
): Promise<string> {
  // FR-15.12b: publishing paused — refused at the point of the Sanity write, the single
  // choke point all three publish paths share (decision endpoint, Workflow publish step,
  // hourly publisher). Drafting continues; NOTHING bypasses this switch (design §10.1).
  const flags = await getFlags(db);
  if (flags["publishing.paused"]) {
    throw new GateError(
      "publishing_paused",
      "Publishing is paused by an administrator — no content will go live until it is resumed in admin settings (FR-15.12). The draft is unaffected and can be published after resuming.",
    );
  }

  const target = targetOf(args.user);
  const row = await db.query.drafts.findFirst({ where: eq(schema.drafts.id, args.draftId) });
  if (!row?.sanityDocumentId) throw new Error(`Draft ${args.draftId} has no Sanity document`);

  const dateField = target.projectId === "5gz3ngjs" ? "publishDate" : "datePublished";
  const doc = await getDocument(env, target, row.sanityDocumentId);
  if (doc) {
    await mutate(env, target, [
      {
        patch: {
          id: row.sanityDocumentId,
          set: {
            [dateField]: new Date().toISOString(),
            // Afnan's site: the reviewer's per-draft public/em choice (design §8);
            // the draft carried a provisional "public" until approval
            ...(target.projectId === "5gz3ngjs" && row.blogType ? { blogType: row.blogType } : {}),
          },
        },
      },
    ]);
  }
  const publishedId = await publishSanityDraft(env, target, row.sanityDocumentId);
  await db
    .update(schema.drafts)
    .set({ status: "published", sanityDocumentId: publishedId, markdown: null, decidedAt: new Date() }) // DR-9.11 purge
    .where(eq(schema.drafts.id, args.draftId));

  // FR-6.14/design §8: a produced translation becomes the second document, per site.
  // Best-effort AFTER the primary publish — its failure must never roll that back.
  try {
    await publishTranslatedEdition(env, db, target, { draftId: args.draftId, runId: row.runId, publishedId, blogType: row.blogType });
  } catch (e) {
    console.warn("translated edition publish failed — primary is live:", e instanceof Error ? e.message : e);
  }
  return publishedId;
}

interface TranslationMeta {
  title: string;
  excerpt: string;
  imageAlt: string;
  targetLanguage: "ar" | "en";
}

/**
 * The draft's CURRENT-revision translation row, produced only. A produced row from an
 * earlier revision is stale (the article changed, or the user dropped the re-derived
 * one) and must never publish.
 */
export async function currentProducedTranslation(db: Db, draftId: string) {
  const [latest] = await db
    .select({ revisionNo: schema.draftDerivatives.revisionNo })
    .from(schema.draftDerivatives)
    .where(eq(schema.draftDerivatives.draftId, draftId))
    .orderBy(desc(schema.draftDerivatives.revisionNo))
    .limit(1);
  if (!latest) return null;
  const [row] = await db
    .select()
    .from(schema.draftDerivatives)
    .where(
      and(
        eq(schema.draftDerivatives.draftId, draftId),
        eq(schema.draftDerivatives.kind, "translation"),
        eq(schema.draftDerivatives.revisionNo, latest.revisionNo),
      ),
    );
  if (!row || row.outcome !== "produced" || !row.content || !row.meta) return null;
  return { markdown: row.content, meta: row.meta as unknown as TranslationMeta };
}

async function publishTranslatedEdition(
  env: Env,
  db: Db,
  target: SanityTarget,
  args: { draftId: string; runId: string; publishedId: string; blogType: "public" | "em" | null },
): Promise<void> {
  const translation = await currentProducedTranslation(db, args.draftId);
  if (!translation) return; // not requested, dropped, or failed — nothing to publish

  // The published primary document supplies everything language-independent.
  const primary = (await getDocument(env, target, args.publishedId)) as Record<string, unknown> | null;
  if (!primary) return;
  const gen = (primary.generationMeta ?? {}) as { provider?: string; model?: string; sourceUrls?: string[] };
  const imageField = (target.projectId === "5gz3ngjs" ? primary.featuredImage : primary.image) as
    | { asset?: { _ref?: string } }
    | undefined;

  const doc = mapTranslatedForProject(target.projectId, {
    runId: args.runId,
    targetLanguage: translation.meta.targetLanguage,
    title: translation.meta.title,
    excerpt: translation.meta.excerpt,
    imageAlt: translation.meta.imageAlt,
    markdown: translation.markdown,
    baseSlug: ((primary.slug as { current?: string } | undefined)?.current ?? args.runId).toString(),
    tags: (primary.tags as string[] | undefined) ?? [],
    aiDisclosure: primary.aiDisclosure === true,
    provider: gen.provider ?? "unknown",
    model: gen.model ?? "unknown",
    imageAssetId: imageField?.asset?._ref,
    blogType: args.blogType ?? "public",
    sourceUrls: gen.sourceUrls ?? [],
  });
  // Published _id (no drafts. prefix): reached only after the production-only primary
  // publish succeeded, so the FR-8.5 drafts-only rule holds for staging by construction.
  const mutations: Record<string, unknown>[] = [{ createOrReplace: doc }];
  if (target.projectId === "5gz3ngjs") {
    const primaryLang = (primary.language as string | undefined) ?? "en";
    mutations.push({
      createOrReplace: translationMetadataDoc(args.runId, "blogPost", [
        { lang: primaryLang, docId: args.publishedId },
        { lang: translation.meta.targetLanguage, docId: translatedDocId(args.runId, translation.meta.targetLanguage) },
      ]),
    });
  }
  await mutate(env, target, mutations);
  console.log("published translated edition", { runId: args.runId, lang: translation.meta.targetLanguage });
}

/** FR-7.6: an urgent retract covers the translated edition too — best-effort, id is deterministic. */
export async function retractTranslatedEdition(
  env: Env,
  db: Db,
  target: SanityTarget,
  draft: { id: string; runId: string },
): Promise<void> {
  const translation = await currentProducedTranslation(db, draft.id);
  if (!translation) return;
  try {
    await retractPublished(env, target, translatedDocId(draft.runId, translation.meta.targetLanguage));
  } catch (e) {
    console.warn("translated edition retract failed (may not exist):", e instanceof Error ? e.message : e);
  }
}
