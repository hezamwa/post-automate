import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../shared/env";
import { verifyAccessToken, type AccessClaims } from "./tokens";

// JWT middleware (FR-2.2/2.3/2.5): attaches userId + role; every query downstream is
// scoped by the authenticated userId, never by request input.

export type AuthVars = { userId: string; role: "user" | "admin" };
export type AuthedEnv = { Bindings: Env; Variables: AuthVars };

async function authenticate(c: Context<AuthedEnv>): Promise<AccessClaims | null> {
  const header = c.req.header("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  return verifyAccessToken(c.env.JWT_SIGNING_KEY, header.slice("Bearer ".length));
}

export const requireAuth: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  const claims = await authenticate(c);
  if (!claims) {
    return c.json({ error: "Authentication required — provide a Bearer access token (FR-2.2)." }, 401);
  }
  c.set("userId", claims.userId);
  c.set("role", claims.role);
  await next();
};

// FR-2.5: all /admin/* routes require the admin role.
export const requireAdmin: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  const claims = await authenticate(c);
  if (!claims) {
    return c.json({ error: "Authentication required — provide a Bearer access token (FR-2.2)." }, 401);
  }
  if (claims.role !== "admin") {
    return c.json({ error: "Admin role required (FR-2.5)." }, 403);
  }
  c.set("userId", claims.userId);
  c.set("role", claims.role);
  await next();
};
