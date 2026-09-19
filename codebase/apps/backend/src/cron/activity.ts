// Activity rules (article-workflow §2): a creator counts as active for 7 days after their
// last authenticated app request; a creator who never opened the app is measured from
// account creation.

export const ACTIVE_WINDOW_DAYS = 7;
const DAY_MS = 24 * 3600_000;

export function lastSeen(user: { lastActiveAt: Date | null; createdAt: Date }): Date {
  return user.lastActiveAt ?? user.createdAt;
}

export function isActive(user: { lastActiveAt: Date | null; createdAt: Date }, now = new Date()): boolean {
  return now.getTime() - lastSeen(user).getTime() < ACTIVE_WINDOW_DAYS * DAY_MS;
}

export function daysSince(date: Date, now = new Date()): number {
  return Math.floor((now.getTime() - date.getTime()) / DAY_MS);
}
