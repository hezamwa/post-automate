import type { Db } from "../db/client";
import { sanityToken } from "../modules/publishing/sanity";
import { distinctSanityTargets } from "../db/queries";
import type { Env } from "./env";

// Weekly Sanity dataset export → R2 (NFR-16.3, design §14). The Worker-shaped
// equivalent of `sanity dataset export`: the HTTP export endpoint streams every
// document as ndjson. Asset BINARIES are not included — they live on Sanity's CDN
// and the asset documents (with source URLs) are in the export; the restore
// procedure in docs/runbook.md covers both.

type Fetcher = typeof fetch;

export function backupObjectKey(projectId: string, dataset: string, when: Date): string {
  return `sanity/${projectId}/${dataset}/${when.toISOString().slice(0, 10)}.ndjson`;
}

export async function exportProjectToR2(
  env: Env,
  bucket: R2Bucket,
  target: { projectId: string; dataset: string },
  when: Date,
  fetchImpl: Fetcher = fetch,
): Promise<{ key: string; bytes: number; documents: number }> {
  const res = await fetchImpl(
    `https://${target.projectId}.api.sanity.io/v2021-06-07/data/export/${target.dataset}`,
    { headers: { Authorization: `Bearer ${sanityToken(env, target.projectId)}` } },
  );
  if (!res.ok) {
    throw new Error(`Sanity export failed for ${target.projectId}/${target.dataset}: HTTP ${res.status}`);
  }
  const body = await res.text(); // blog-sized datasets — buffering is fine
  const key = backupObjectKey(target.projectId, target.dataset, when);
  await bucket.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } });
  return { key, bytes: body.length, documents: body.split("\n").filter((l) => l.trim()).length };
}

/** Weekly cron entry: one export per distinct creator project. Failures are per-project. */
export async function backupSanityDatasets(env: Env, db: Db, fetchImpl: Fetcher = fetch): Promise<void> {
  if (!env.BACKUPS) {
    // A backup job that silently doesn't run is worse than none — shout weekly.
    console.error(
      "backup: BACKUPS R2 binding not configured — enable R2 on the account, create the " +
        "'post-automate-backups' bucket, and uncomment the r2_buckets binding (NFR-16.3, docs/runbook.md)",
    );
    return;
  }
  for (const target of await distinctSanityTargets(db)) {
    try {
      const result = await exportProjectToR2(env, env.BACKUPS, target, new Date(), fetchImpl);
      console.log(`backup: exported ${target.projectId}/${target.dataset} → ${result.key} (${result.documents} docs, ${result.bytes} bytes)`);
    } catch (e) {
      console.error(`backup: export failed for ${target.projectId}:`, e instanceof Error ? e.message : e);
    }
  }
}
