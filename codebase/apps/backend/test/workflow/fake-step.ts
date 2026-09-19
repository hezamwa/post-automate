import { NonRetryableError } from "cloudflare:workflows";

// An in-process WorkflowStep for the Node pool. step.do runs the callback immediately
// (retrying without delay up to the configured limit), sleeps are recorded, and
// waitForEvent answers from a scripted queue — an unscripted wait times out, like the
// real engine after its timeout. Every provider call the router mock sees is attributed
// to the step that was running, which is how the one-call-per-step invariant is checked.

export interface ScriptedEvent {
  type: string;
  payload?: unknown;
  /** Script an explicit timeout for the next wait of this type. */
  timeout?: true;
}

export class WaitTimeoutError extends Error {}

type StepConfig = { retries?: { limit: number } };
type StepFn<T> = (ctx: unknown) => Promise<T>;

export class FakeStep {
  /** Step names in execution order (one entry per step, not per attempt). */
  readonly executed: string[] = [];
  readonly sleeps: Array<{ name: string; duration: string | number }> = [];
  readonly waits: Array<{ name: string; type: string; outcome: "answered" | "timeout" }> = [];
  /** Attempts per step name. */
  readonly attempts = new Map<string, number>();
  /** Billable provider calls as reported by the router mock, per step attempt. */
  readonly bills: Array<{ step: string; attempt: number; taskType: string }> = [];
  current: string | null = null;
  private queue: ScriptedEvent[];

  constructor(events: ScriptedEvent[] = []) {
    this.queue = [...events];
  }

  /** Queue events for later waits, in order. */
  script(...events: ScriptedEvent[]): this {
    this.queue.push(...events);
    return this;
  }

  /** Called by the router mock — attributes a billable call to the running step attempt. */
  noteProviderCall(taskType: string): void {
    if (!this.current) throw new Error(`provider call for '${taskType}' outside any step`);
    this.bills.push({ step: this.current, attempt: this.attempts.get(this.current) ?? 1, taskType });
  }

  /** Task types billed by one step (all attempts). */
  billedTasks(step: string): string[] {
    return this.bills.filter((b) => b.step === step).map((b) => b.taskType);
  }

  async do<T>(name: string, configOrFn: StepConfig | StepFn<T>, maybeFn?: StepFn<T>): Promise<T> {
    const config = typeof configOrFn === "function" ? {} : configOrFn;
    const fn = (typeof configOrFn === "function" ? configOrFn : maybeFn)!;
    if (this.executed.includes(name)) throw new Error(`duplicate step name '${name}' — names must be unique per run`);
    this.executed.push(name);
    const limit = config.retries?.limit ?? 0;
    for (let attempt = 0; ; attempt++) {
      this.attempts.set(name, attempt + 1);
      this.current = name;
      try {
        // structuredClone mirrors the engine: outputs must be serialisable, and a step
        // never hands back the same object it built.
        return structuredClone(await fn({ step: { name, count: attempt } }));
      } catch (e) {
        if (e instanceof NonRetryableError || attempt >= limit) throw e;
      } finally {
        this.current = null;
      }
    }
  }

  async sleep(name: string, duration: string | number): Promise<void> {
    this.sleeps.push({ name, duration });
  }

  async sleepUntil(name: string, timestamp: Date | number): Promise<void> {
    this.sleeps.push({ name, duration: typeof timestamp === "number" ? timestamp : timestamp.toISOString() });
  }

  async waitForEvent<T>(name: string, options: { type: string; timeout?: string | number }): Promise<{ type: string; payload: T; timestamp: Date }> {
    const i = this.queue.findIndex((e) => e.type === options.type);
    const event = i >= 0 ? this.queue.splice(i, 1)[0] : undefined;
    if (!event || event.timeout) {
      this.waits.push({ name, type: options.type, outcome: "timeout" });
      throw new WaitTimeoutError(`waitForEvent '${name}' (${options.type}) timed out after ${String(options.timeout ?? "24 hours")}`);
    }
    this.waits.push({ name, type: options.type, outcome: "answered" });
    return { type: options.type, payload: event.payload as T, timestamp: new Date() };
  }

  /** Step attempts that billed more than one provider call — the spec §3 invariant. */
  billingViolations(exclude: string[] = []): Array<{ step: string; calls: string[] }> {
    const perAttempt = new Map<string, string[]>();
    for (const b of this.bills) {
      const key = `${b.step}#${b.attempt}`;
      perAttempt.set(key, [...(perAttempt.get(key) ?? []), b.taskType]);
    }
    return [...perAttempt]
      .filter(([key, calls]) => calls.length > 1 && !exclude.includes(key.replace(/(-rev\d+)?#\d+$/, "")))
      .map(([key, calls]) => ({ step: key.replace(/#\d+$/, ""), calls }));
  }
}
