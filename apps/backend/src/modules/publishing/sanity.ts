// Minimal Sanity HTTP client (raw fetch, Workers-native). Token per project:
// SANITY_TOKEN_<PROJECTID> (FR-8.4). Draft-first: documents live under drafts.*
// until an explicit publish (FR-8.1); non-production environments may NEVER publish (FR-8.5).
import type { Env } from "../../shared/env";

const API_VERSION = "v2024-01-01";

export interface SanityTarget {
  projectId: string;
  dataset: string;
}

function token(env: Env, projectId: string): string {
  const name = `SANITY_TOKEN_${projectId.toUpperCase()}`;
  const value = (env as unknown as Record<string, string | undefined>)[name];
  if (!value) throw new Error(`Missing secret ${name} for Sanity project ${projectId} (FR-8.4)`);
  return value;
}

async function sanityFetch(env: Env, t: SanityTarget, path: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(`https://${t.projectId}.api.sanity.io/${API_VERSION}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token(env, t.projectId)}`,
      ...(init.headers ?? {}),
    },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Sanity ${path} failed (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return json;
}

export async function mutate(env: Env, t: SanityTarget, mutations: unknown[]): Promise<void> {
  await sanityFetch(env, t, `/data/mutate/${t.dataset}?returnIds=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mutations }),
  });
}

export async function getDocument(env: Env, t: SanityTarget, id: string): Promise<Record<string, unknown> | null> {
  const json = (await sanityFetch(env, t, `/data/doc/${t.dataset}/${id}`, { method: "GET" })) as {
    documents?: Array<Record<string, unknown>>;
  };
  return json.documents?.[0] ?? null;
}

/** Upload a hero image; returns the image asset document _id (FR-6.13). */
export async function uploadImageAsset(
  env: Env,
  t: SanityTarget,
  imageBase64: string,
  mimeType: string,
  filename: string,
): Promise<string> {
  const bytes = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));
  const json = (await sanityFetch(
    env,
    t,
    `/assets/images/${t.dataset}?filename=${encodeURIComponent(filename)}`,
    { method: "POST", headers: { "Content-Type": mimeType }, body: bytes },
  )) as { document?: { _id?: string } };
  const id = json.document?._id;
  if (!id) throw new Error("Sanity image upload returned no asset id");
  return id;
}

export function assertCanPublish(env: Env): void {
  if (env.ENVIRONMENT !== "production") {
    throw new Error(
      `Publish refused: ENVIRONMENT=${env.ENVIRONMENT} writes drafts only (FR-8.5 — staging never publishes)`,
    );
  }
}

/** Publish = copy the draft to the published id + delete the draft (FR-8.1). */
export async function publishDraft(env: Env, t: SanityTarget, draftId: string): Promise<string> {
  assertCanPublish(env);
  const doc = await getDocument(env, t, draftId);
  if (!doc) throw new Error(`Draft ${draftId} not found in ${t.projectId}/${t.dataset}`);
  const publishedId = draftId.replace(/^drafts\./, "");
  await mutate(env, t, [
    { createOrReplace: { ...doc, _id: publishedId } },
    { delete: { id: draftId } },
  ]);
  return publishedId;
}

/** Urgent retract (FR-7.6): move the published doc back to a draft. */
export async function retractPublished(env: Env, t: SanityTarget, publishedId: string): Promise<void> {
  const doc = await getDocument(env, t, publishedId);
  if (!doc) throw new Error(`Published doc ${publishedId} not found`);
  await mutate(env, t, [
    { createOrReplace: { ...doc, _id: `drafts.${publishedId}` } },
    { delete: { id: publishedId } },
  ]);
}

/** Reject/discard cleanup (FR-7.8): remove the Sanity draft entirely. */
export async function deleteDraft(env: Env, t: SanityTarget, draftId: string): Promise<void> {
  await mutate(env, t, [{ delete: { id: draftId } }]);
}
