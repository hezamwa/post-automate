// API client for the admin dashboard (OD-17): same /auth JWT flow as the app (FR-2.2),
// role=admin enforced server-side on every /admin/* route (FR-2.5). Tokens live in
// localStorage; a 401 triggers one silent refresh-and-retry before logging out.

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
}

interface Session {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

const STORAGE_KEY = "postautomate.admin.session";

export function getSession(): Session | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function saveSession(s: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function login(email: string, password: string): Promise<SessionUser> {
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  const body = (await res.json()) as Session;
  if (body.user.role !== "admin") {
    throw new ApiError(403, "This dashboard requires the admin role (FR-2.5).");
  }
  saveSession(body);
  return body.user;
}

async function tryRefresh(): Promise<boolean> {
  const session = getSession();
  if (!session) return false;
  const res = await fetch("/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  if (!res.ok) {
    clearSession();
    return false;
  }
  saveSession((await res.json()) as Session);
  return true;
}

/** Authenticated JSON call; refreshes once on 401, then surfaces the API's message. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = getSession();
    if (!session) throw new ApiError(401, "Not logged in.");
    const res = await fetch(path, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
        authorization: `Bearer ${session.accessToken}`,
      },
    });
    if (res.status === 401 && attempt === 0 && (await tryRefresh())) continue;
    if (!res.ok) throw new ApiError(res.status, await readError(res));
    return (await res.json()) as T;
  }
  throw new ApiError(401, "Session expired — log in again.");
}
