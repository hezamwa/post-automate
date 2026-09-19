// Node-pool stand-in for `cloudflare:workers` (workflow tests). Only the value export
// pipeline.ts needs at module load; the pipeline itself runs against a FakeStep.
export class WorkflowEntrypoint<Env = unknown, T = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
  run(_event: { payload: T }, _step: unknown): Promise<unknown> {
    throw new Error("stub WorkflowEntrypoint.run — tests drive runPipeline() directly");
  }
}
