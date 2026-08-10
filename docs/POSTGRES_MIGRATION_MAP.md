# SQLite → PostgreSQL Migration Map

**Status: not started, and not scheduled.** SQLite remains the active data
store. This document exists so that when a deployment genuinely needs more
than one application instance, the work is already scoped rather than
discovered.

Nothing here has been executed. No schema was changed for this document.

---

## Why this migration is the one that matters

Every other portability item is an adapter swap. This one is a data
migration, and it is the gate on horizontal scale: SQLite over a shared
volume serves exactly one writer, so the application tier cannot scale
until the data store does. See `CLOUD_PORTABILITY.md` §4.

---

## Classification of every SQLite-specific construct

Counts are from the current `src/server` tree.

### PORTABLE — works unchanged on PostgreSQL

| Construct | Occurrences | Note |
|---|---|---|
| `CREATE TABLE` / `TEXT` / `REAL` / `INTEGER` columns | schema-wide | Standard types; `TEXT` maps to `text`, `REAL` to `double precision`. |
| Parameterised `?` statements | throughout `db/` | Mechanical rewrite to `$1..$n`, no semantic change. |
| `ON CONFLICT … DO UPDATE` | 13 | PostgreSQL supports the same upsert syntax. |
| `INSERT OR IGNORE` | 2 | Becomes `ON CONFLICT DO NOTHING`. |
| Foreign keys, `CHECK` constraints, indexes | schema-wide | Standard. |
| `GROUP_CONCAT` | 1 | Becomes `string_agg`. |
| ISO-8601 timestamps stored as `TEXT` | throughout | Already portable; can stay `text` or become `timestamptz` as a later cleanup. |

**No `AUTOINCREMENT`, no `json_extract`, no `strftime`, no `julianday`, no
`WITHOUT ROWID`, no `last_insert_rowid()`.** The schema avoided the worst
SQLite-isms from the start.

### SQLITE-SPECIFIC BUT CONTAINED — rewritten in one place

| Construct | Occurrences | Where | Replacement |
|---|---|---|---|
| `PRAGMA foreign_keys` | 11 | `db/index.ts` migrations | PostgreSQL enforces FKs by default; deferred constraints where migrations need them. |
| `PRAGMA journal_mode = WAL` | 1 | `db/index.ts` | No equivalent needed — PostgreSQL has its own WAL. |
| `PRAGMA user_version` | 6 | schema versioning | A `schema_migrations` table. |
| `PRAGMA table_info` | 2 | `hasColumn()` | `information_schema.columns`. |
| `PRAGMA quick_check` / `foreign_key_check` | 3 | `ops/storage.ts` | Managed-service health checks; `pg_catalog` constraint validation. |
| `PRAGMA defer_foreign_keys` | 1 | table-rebuild migration | `SET CONSTRAINTS ALL DEFERRED`. |
| `VACUUM INTO` | 1 | `ops/backups.ts` | `pg_dump` / managed snapshot — see below. |
| Table-rebuild migrations (`CREATE new → copy → DROP → RENAME`) | several | `db/index.ts` | PostgreSQL supports `ALTER TABLE` directly; these become simpler, not harder. |

### POSTGRES MIGRATION WORK — needs a decision, not just a rewrite

| Issue | Occurrences | Why it needs thought |
|---|---|---|
| **`rowid` as an ORDER BY tiebreaker** | 8 | PostgreSQL has no `rowid`. Queries like `ORDER BY created_at, rowid` rely on SQLite's implicit insertion order to make same-timestamp rows deterministic. **This is the single most important item in this document**: draw line items, draw events, documents and evidence links all order this way, and a non-deterministic order changes what a lender sees. Fix: add an explicit monotonic `seq BIGSERIAL` per affected table and order by it. Must be done *with* the migration, never after. |
| **Transaction semantics** | throughout | `node:sqlite` is synchronous and single-connection; every write is effectively serialised. PostgreSQL introduces real concurrency, so any read-modify-write currently safe by virtue of single-threaded execution needs explicit transaction scoping and, where it matters, row-level locking. The Evidence Ledger's hash-chain append is the critical case: concurrent appends must serialise or the chain forks. |
| **Boolean storage** | throughout | Booleans are `INTEGER 0/1` and read back as numbers. PostgreSQL `boolean` returns `true`/`false`; every `=== 1` / `? 1 : 0` site needs converting, or the columns stay `smallint`. Mechanical but wide. |
| **Synchronous API** | every repo function | `node:sqlite` is sync; every PostgreSQL driver is async. Repo functions become `async`, which propagates to their callers. This is the largest mechanical change and the main reason the migration is a project, not a patch. |
| **Connection pooling** | none today | New concern: pool sizing, timeouts, and readiness checks that survive a failover. |
| **Backups** | `ops/backups.ts` | `VACUUM INTO` disappears. See below. |

---

## Backup architecture across engines

`BackupService` should represent **create / verify / metadata / status** —
not `VACUUM INTO`. The current implementation happens to use `VACUUM INTO`
because that is how SQLite takes a consistent, compacted snapshot; the
concept is "a verifiable point-in-time copy", and that survives the engine
change.

| | SQLite (current) | PostgreSQL (future) |
|---|---|---|
| Create | `VACUUM INTO` a timestamped file | `pg_dump`, or a managed automated backup / PITR |
| Verify | reopen read-only, `PRAGMA quick_check`, sha256 | restore into a scratch database and validate |
| Metadata | size, sha256, schema version, app commit | same fields, plus LSN / backup label |
| Status | recorded in `backup_records` | unchanged |
| Restore | **out of band, by an operator** | **out of band, by an operator** |

The no-in-app-restore rule does not change. Restore stays an operator
action with the database offline, in every engine.

---

## Sequence, when it is time

1. Add explicit `seq` ordering columns and switch every `rowid` tiebreaker to them — **on SQLite first**, so the ordering change is proven under the current engine before the engine changes.
2. Convert repo functions to async against the existing SQLite implementation.
3. Introduce a PostgreSQL implementation behind the same repo surface.
4. Convert booleans and timestamps.
5. Migrate data; run both engines against the same test battery.
6. Only then allow more than one application instance.

Steps 1 and 2 are safe to do at any time and remove most of the risk from
the rest.

---

## Azure and private-cloud targets

| | Azure | Private / sovereign |
|---|---|---|
| Engine | Azure Database for PostgreSQL Flexible Server | PostgreSQL (self-managed or operator-managed) |
| HA | zone-redundant HA | streaming replication + failover |
| Backup | automated backups + PITR | `pg_dump` / `pgBackRest` to WORM object storage |
| Network | private endpoint, no public access | private network only |
| Secrets | connection string from Key Vault | Vault / KMS |

Neither target changes anything in this document except who operates the
server.
