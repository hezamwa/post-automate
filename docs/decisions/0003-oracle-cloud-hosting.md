# 0003. Oracle Cloud as the single cloud

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

V1 ran on Cloudflare Workers. For V2, the owner wants all services in one cloud, so there is one place to manage them.

## Decision

- Host V2 on Oracle Cloud, not Cloudflare Workers.
- The API runs on an Ampere A1 VM with Docker Compose. The Always Free allowance is 2 OCPUs and 12 GB.
- Convert the account to Pay As You Go on day one, so the idle VM isn't reclaimed, and add a budget alert.
- The VM is stateless and disposable. No database runs on it ([0004](0004-database.md)).

## Consequences

- One console and one bill for compute and, later, the database.
- The API, Hangfire and any sidecars must fit within 2 OCPUs and 12 GB.
- **Open:** whether "one cloud" also covers DNS and ingress (Cloudflare DNS and Tunnel today), admin hosting, and the container registry.
