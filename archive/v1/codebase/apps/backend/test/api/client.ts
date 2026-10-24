import { api } from "../../src/api";
import { issueAccessToken } from "../../src/auth/tokens";
import type { Env } from "../../src/shared/env";

// API tests drive the real Hono router with the workflow mocks (import ../workflow/preamble
// first) and a fake PIPELINE binding: instances created through it record the events they
// receive; an unknown id throws, which is how the routes discover an instance is gone.

const SECRET = "test-signing-key";

export interface FakeInstance {
  id: string;
  events: Array<{ type: string; payload: unknown }>;
}

export function fakePipeline() {
  const instances = new Map<string, FakeInstance>();
  const binding = {
    create: async ({ id }: { id: string }) => {
      instances.set(id, { id, events: [] });
      return { id };
    },
    get: async (id: string) => {
      const instance = instances.get(id);
      if (!instance) throw new Error(`instance ${id} not found`);
      return {
        id,
        sendEvent: async (event: { type: string; payload: unknown }) => {
          instance.events.push(event);
        },
        status: async () => ({ status: "waiting" }),
      };
    },
  };
  return { binding, instances };
}

export function apiEnv(pipeline = fakePipeline()) {
  return { env: { ENVIRONMENT: "production", JWT_SIGNING_KEY: SECRET, PIPELINE: pipeline.binding } as unknown as Env, pipeline };
}

export const tokenFor = (userId: string, role: "user" | "admin" = "user") => issueAccessToken(SECRET, { userId, role });

export async function call(
  env: Env,
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await api.request(
    path,
    {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    },
    env,
  );
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
