// v1 → v2 cutover: a draft parked at approval under the OLD pipeline code cannot be replayed
// by the new code (step outputs changed shape). Flag it stale so the decision endpoint goes
// straight to direct handling (approve/reject still work — spec §5.1) instead of poking the
// old instance. Dry run by default; --apply writes. Prints the run ids so the old instances
// can be terminated: wrangler workflows instances terminate pipeline-production <run id>.
//   pnpm tsx scripts/mark-parked-stale.ts [--apply]
import postgres from "postgres";
import { describeUrl, loadDatabaseUrl } from "./db-status";

async function main() {
  const apply = process.argv.includes("--apply");
  const url = loadDatabaseUrl();
  console.log(`${apply ? "applying to" : "dry run against"}: ${describeUrl(url)}`);
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const parked = await sql<{ draft_id: string; run_id: string; instance: string | null; status: string }[]>`
      select d.id as draft_id, r.id as run_id, r.workflow_instance_id as instance, d.status
      from drafts d join pipeline_runs r on r.id = d.run_id
      where d.status in ('pending_approval', 'revising') and d.stale = false and r.workflow_instance_id is not null`;
    if (parked.length === 0) {
      console.log("nothing parked — no draft to flag");
      return;
    }
    for (const p of parked) console.log(`draft ${p.draft_id} (${p.status}) · run ${p.run_id} · instance ${p.instance}`);
    if (!apply) {
      console.log("\ndry run — re-run with --apply to flag these stale");
      return;
    }
    await sql`update drafts set stale = true where id in ${sql(parked.map((p) => p.draft_id))}`;
    console.log(`\nflagged ${parked.length} draft(s) stale. Terminate the old instance(s) with:`);
    for (const p of parked) console.log(`  pnpm exec wrangler workflows instances terminate pipeline-production ${p.instance}`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
