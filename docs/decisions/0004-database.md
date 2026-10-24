# 0004. PostgreSQL for development, switchable provider

- **Status:** Accepted for development; production open
- **Date:** 2026-10-24

## Context

The production database isn't chosen. Options considered:

- **Oracle Autonomous AI Database (Always Free):** in the same cloud ([0003](0003-oracle-cloud-hosting.md)). The free tier can't restore from a backup or a point in time.
- **OCI Database with PostgreSQL:** managed and in the same cloud, but not free.
- **Neon PostgreSQL:** managed and free at this scale, but a second cloud.

Development needs a database now, and the choice for production must not force code changes later.

## Decision

- **Development** uses PostgreSQL.
- **Production** is decided later. If it is PostgreSQL, it runs as a managed service, never on the VM.
- **The provider stays switchable:**
  - DbContexts, entity configurations and repositories in `<Module>.Infrastructure` use only provider-neutral EF Core.
  - Engine-specific code, SQL and migrations live only in `<Module>.Infrastructure.<Provider>` and `BuildingBlocks.Infrastructure.<Provider>`. Today that is `.PostgreSql`.
  - `BuildingBlocks.Infrastructure` will define `IDatabaseProvider`, and the Host will pick the implementation from the `Database:Provider` setting.
  - Each module owns its own schema and migrations history, with no foreign keys across schemas.
  - Architecture tests will allow engine packages (e.g. Npgsql) only in provider projects.

## Consequences

- Switching engines means adding one provider project per module and one in BuildingBlocks, plus changing a setting. Domain, Application and Presentation don't change.
- A switch still needs a baseline migration per module for the new engine and a one-off data copy.
- Integration tests run against the real engine in containers, one fixture per provider.
