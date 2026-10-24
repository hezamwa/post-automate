// Create or refresh the STAGING Neon branch (design §14, spec §2 "staging must move to its
// own Neon branch") and print what wrangler needs. Idempotent: an existing `staging`
// branch is reset to its parent (production data as of now) instead of recreated.
//
//   NEON_API_KEY=… NEON_PROJECT_ID=… pnpm tsx scripts/neon-staging-branch.ts
//
// Then: wrangler hyperdrive create post-automate-staging --connection-string="<printed uri>"
// and put the returned id in wrangler.jsonc → env.staging.hyperdrive[0].id (runbook §5).
// Never a Worker secret — this runs on a laptop, once (or when staging data should be fresh).

const API = "https://console.neon.tech/api/v2";
const BRANCH_NAME = "staging";

const apiKey = process.env.NEON_API_KEY;
const projectId = process.env.NEON_PROJECT_ID;
if (!apiKey || !projectId) throw new Error("NEON_API_KEY and NEON_PROJECT_ID are required");

async function neon<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(`Neon ${method} ${path} → HTTP ${res.status}: ${json.message ?? JSON.stringify(json).slice(0, 200)}`);
  return json;
}

interface Branch {
  id: string;
  name: string;
  parent_id?: string;
  default?: boolean;
}

async function main() {
  const { branches } = await neon<{ branches: Branch[] }>("GET", `/projects/${projectId}/branches`);
  const primary = branches.find((b) => b.default) ?? branches.find((b) => !b.parent_id);
  if (!primary) throw new Error("no primary branch found");
  let staging = branches.find((b) => b.name === BRANCH_NAME);

  if (staging) {
    console.log(`branch '${BRANCH_NAME}' exists (${staging.id}) — resetting to '${primary.name}' as of now`);
    await neon("POST", `/projects/${projectId}/branches/${staging.id}/restore`, { source_branch_id: primary.id });
  } else {
    console.log(`creating branch '${BRANCH_NAME}' from '${primary.name}' (${primary.id})`);
    const created = await neon<{ branch: Branch }>("POST", `/projects/${projectId}/branches`, {
      branch: { name: BRANCH_NAME, parent_id: primary.id },
      endpoints: [{ type: "read_write" }],
    });
    staging = created.branch;
  }

  const { databases } = await neon<{ databases: Array<{ name: string; owner_name: string }> }>("GET", `/projects/${projectId}/branches/${staging.id}/databases`);
  const db = databases[0];
  if (!db) throw new Error("the staging branch has no database");
  const { uri } = await neon<{ uri: string }>(
    "GET",
    `/projects/${projectId}/connection_uri?branch_id=${staging.id}&database_name=${encodeURIComponent(db.name)}&role_name=${encodeURIComponent(db.owner_name)}&pooled=false`,
  );
  console.log(`\nstaging branch: ${staging.id}`);
  console.log(`connection uri (direct, for migrations and the Hyperdrive config):\n${uri}\n`);
  console.log(`next:\n  DATABASE_URL="${uri}" pnpm db:migrate\n  wrangler hyperdrive create post-automate-staging --connection-string="${uri}"\n  → wrangler.jsonc env.staging.hyperdrive[0].id = <the id printed above>`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
