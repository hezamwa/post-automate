# Decision records

One file per decision that shapes the system, numbered in the order it was made. A record is never edited to change its outcome. A new record supersedes it, and the old one's status points to the new one.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-repository-layout.md) | Repository layout and V1 archive | Accepted |
| [0002](0002-modular-monolith-clean-architecture.md) | Modular monolith with Clean Architecture and DDD | Accepted |
| [0003](0003-oracle-cloud-hosting.md) | Oracle Cloud as the single cloud | Accepted |
| [0004](0004-database.md) | PostgreSQL for development, switchable provider | Accepted; production open |
| [0005](0005-standalone-admin-spa.md) | Standalone admin SPA | Accepted |

Each record has: **Status**, **Date**, **Context**, **Decision**, **Consequences**.
