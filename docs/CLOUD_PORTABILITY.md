# OBV Cloud Portability

**Status: architecture documentation.** OBV runs today on a single Docker
container with SQLite and a mounted volume. Nothing in this document has
been migrated, provisioned or deployed. Its purpose is to record where the
application touches infrastructure, which of those touches are boundaries
and which are still couplings, so a future move to Azure or to a private
cloud is a matter of swapping adapters and migrating data rather than
rewriting governed workflows.

The pilot's deployment is unchanged: Docker + `OBV_DATA_DIR` + SQLite +
persistent disk + Postmark + OBV identity. **No cloud credential is
required to run OBV.**

---

## 1. Dependency inventory

Every place the application meets infrastructure, classified:

| # | Dependency | Where | Class | Notes |
|---|---|---|---|---|
| 1 | **SQLite (`node:sqlite`)** | `db/index.ts`, `db/*Repo.ts`, `ops/storage.ts`, `ops/backups.ts` | **B — acceptable pilot coupling** | Contained. Application services do not open the database: outside `db/`, only `ops/backups.ts` (7), `ops/storage.ts` (5), `http/server.ts` (4) and `changeOrders.ts` (1) hold a handle. See `POSTGRES_MIGRATION_MAP.md`. |
| 2 | **Filesystem paths** | `DATA_DIR`, `UPLOADS_DIR`, `WORM_DIR`, `REPORTS_DIR`, `AUDIT_PACKAGES_DIR` in `db/index.ts` | **C → done** | Resolution consolidated behind `services/storage/objectStore.ts`. |
| 3 | **Artifact references in records** | `photo_path`, `payload_path`, `storage_object_key`, `media_path` | **A — already provider-neutral** | Records store LOGICAL keys (`/worm/x.jpg`, `audit-packages/<id>/<file>`), never absolute host paths. Asserted by `cloud-portability-test.js`. |
| 4 | **Single-node persistence** | SQLite over one volume | **C → done (disclosed)** | Was an undocumented assumption; now stated in the startup log, `/api/ready` and `pilot:check`. See §4. |
| 5 | **Render environment variables** | `RENDER_EXTERNAL_URL`, `RENDER_GIT_COMMIT`, `RENDER_GIT_BRANCH` | **C → done** | Read only in `services/platform/runtime.ts`; generic `OBV_*` names take precedence, platform names remain a compatibility fallback. |
| 6 | **Postmark** | `services/integrations/email.ts` | **A — already provider-neutral** | One adapter among six positions behind `EmailProvider`. Identity never names it. |
| 7 | **Anthropic** | `services/verification/`, `AI_PROVIDER` | **A** | Advisory analysis only; governance never depends on which model ran. |
| 8 | **Microsoft Graph / Teams** | `services/teamsSync/`, `teamsCards.ts` | **E — intentionally external** | A notification channel. Should stay vendor-specific; it *is* Microsoft. |
| 9 | **WhatsApp (Meta)** | `services/whatsappSync/` | **E — intentionally external** | Same reasoning. |
| 10 | **Object/file persistence** | evidence, uploads, reports, packages, official-source payloads | **C → partially done** | Boundary and local implementation exist; most callers still use direct paths. See §5. |
| 11 | **Platform commit metadata** | health payload, backup records, preview banner | **C → done** | All three now resolve through `runtime.appCommit()`. |
| 12 | **Local scheduled work** | webhook dispatch `setInterval` | **B** | Off by default, in-process, `unref()`ed, cleared on shutdown. A multi-instance deployment needs a single-runner strategy — recorded as FUTURE. |
| 13 | **Single-process execution** | in-process timers; no leader election | **B** | Correct for the current single-writer deployment; bounded by §4's constraint. |
| 14 | **Public URL** | invitation/magic links, Teams cards, webhook callback | **C → done** | `runtime.publicBaseUrl()`. |
| 15 | **Health/deployment behaviour** | `/api/health`, `/api/ready` | **A** | Capability vocabularies, no vendor names. Asserted. |
| 16 | **Process lifecycle** | SIGTERM/SIGINT | **C → done** | Was absent entirely. See §6. |
| 17 | **Secrets** | environment variables | **A** | Never persisted, never logged. Asserted against the schema. |
| 18 | **Chromium / PDF rendering** | `scripts/render-pdf.js`, Dockerfile | **B** | Works in any container that has the image's Chromium. Not platform-specific. |

**Not refactored on purpose.** Teams, WhatsApp and the Anthropic adapter
mention vendors because they *are* those vendors. Abstracting a Microsoft
Graph client behind a neutral interface with one implementation would add
indirection and remove nothing.

---

## 2. Target portability model

```
Application / Governance Layer      ← never changes when infrastructure does
        |
        +-- DataStore            SQLite (repo layer)          B
        +-- ObjectStore          LocalObjectStore             C → boundary exists
        +-- SecretProvider       environment variables        A
        +-- EmailProvider        Postmark + 5 positions       A
        +-- IdentityProvider     OBV native passwordless      A
        +-- AIProvider           Anthropic (advisory only)    A
        +-- NotificationProvider Teams / WhatsApp / email     A
        +-- ExternalSourceProvider  official-source connectors A
        +-- RuntimePlatform      services/platform/runtime.ts C → done
```

Interfaces were added only where a seam did not already exist. `EmailProvider`,
the notification channels and the official-source connectors were already
effective seams and were left alone.

---

## 3. What makes the claim structurally true

OBV has **zero runtime dependencies**. Every import in `src/` is either
relative or a `node:` built-in — asserted, not asserted-to. A cloud SDK
cannot leak into governed code without failing the build's test battery,
which is what turns "vendor adapters belong at the boundary" from a
convention into a property.

---

## 4. The single-writer constraint

SQLite over a mounted volume serves **exactly one** application instance.
OBV performs no cross-instance locking, so a second replica pointed at the
same data directory can corrupt the database with no error and no obvious
symptom.

This used to live only in an operator's memory. It is now disclosed in
three places an operator actually reads:

- the startup log — `Data store: engine=sqlite · max writer instances=1 · horizontal scale=NOT SUPPORTED`
- `GET /api/ready` — `dataStore: { engine, maxWriterInstances, supportsHorizontalScale }`
- `npm run pilot:check` — an `instance constraint` line

No distributed locking was invented. There is no safe way to make one
SQLite file serve several application instances across a network; the path
to multiple writers is PostgreSQL.

| | Current | Future |
|---|---|---|
| Application tier | 1 instance | many instances |
| Data store | SQLite + persistent block volume | PostgreSQL |
| Artifacts | local volume | object storage |

---

## 5. Object storage boundary

`services/storage/objectStore.ts` defines the contract a backend must
satisfy — `exists`, `get`, `metadata`, `verifyHash`, `openReadStream`,
`put`, `withLocalFile` — and ships `LocalObjectStore`, which reproduces
the existing resolution rules exactly. **No data moved and no stored key
changed.**

**The contract is asynchronous and path-free.** Every method returns a
`Promise`; streams are Node's generic `Readable`, never `fs.ReadStream`;
and no method exposes where bytes physically live. A remote store
performs network I/O and has no host path to offer, so the neutral
interface promises neither — that is what makes "Azure/S3 is an adapter"
honest rather than aspirational. The few operations that genuinely need a
file on disk (ZIP assembly, Chromium/PDF tooling) use
`withLocalFile(key, fn)`: the path is valid only during the callback, the
local store lends its original file, and a pathless store downloads to a
temporary file and removes it afterwards. Callers cannot tell which
happened.

`ObjectClass.IMMUTABLE` expresses the write-once policy independently of
where bytes live: once written, an object is never replaced, enforced by
refusing overwrite. Three distinct layers, stated precisely:

- **storage policy** prevents ordinary replacement (what the store enforces);
- **the Evidence Ledger's hash chain** *detects* tampering (what proves integrity);
- **infrastructure-enforced retention** (Azure Blob immutability policies,
  S3 Object Lock in compliance mode) is a *stronger* future guarantee that
  local write-once does **not** claim to equal.

The contract is proven against two implementations: the production
`LocalObjectStore` and `MemoryObjectStore`, an in-memory **test double**
(wired to nothing) whose only job is to prove callers do not secretly
depend on the filesystem. A property only the local store satisfies is a
filesystem assumption, not a contract.

**No Azure or S3 adapter was written.** An adapter with no credentials, no
configuration and no caller is decoration. A future adapter must satisfy:

| Guarantee | Local | Azure Blob | S3-compatible |
|---|---|---|---|
| Write-once for IMMUTABLE | refuse overwrite | immutability policy / legal hold | Object Lock (compliance mode) |
| Content addressable by key | path under data root | blob name | object key |
| Hash verification | sha256 on read | sha256 on read (MD5 property insufficient) | sha256 on read |
| Streamed read | generic `Readable` | blob download stream | `GetObject` stream |
| Local-file lease | lend the original file | download to temp, delete after | download to temp, delete after |

### Adoption status — the honest version

The boundary exists and its first adopter is converted; **most artifact
flows still reach the filesystem directly**. A future migration converts
the remaining callers *before* an adapter swap changes anything.

| Caller | Direct-path use | Class | Disposition |
|---|---|---|---|
| `auditPackage.ts` — evidence existence + media copy | none (converted) | **A — uses ObjectStore now** | Done. Path-free: `exists()` + `get()`. |
| `auditPackage.ts` — package ZIP write/read under `AUDIT_PACKAGES_DIR` | direct | **C — migration candidate** | Package assembly writes its own output; convert with `put()`/`openReadStream` when packages move off-volume. |
| `WormEvidenceStore.ts` — evidence write + ledger append | direct | **C — migration candidate** | The WORM write and hash-chain append must convert TOGETHER in one change; splitting them risks a ledger entry for bytes that failed to land. Deliberately not converted piecemeal. |
| `officialSources/retrieval.ts` — snapshot payload files | direct | **C — migration candidate** | Straightforward `put()`/`get()` conversion. |
| `permits.ts` — permit documents under uploads | direct | **C — migration candidate** | Straightforward. |
| `report/data.ts` — rendered report artifacts | direct | **C — migration candidate** | DERIVED class; regenerable. |
| `http/server.ts` — static serving of `/worm/`, `/uploads/`, report cache | direct | **C — migration candidate** | Becomes `openReadStream` per key; response streaming already exists. |
| `ops/backups.ts` / `ops/storage.ts` — database file itself | direct | **B — legitimately local** | The SQLite file is infrastructure, not an application artifact; it is replaced by PostgreSQL, not by object storage. |
| `db/seed.ts` — demo media provisioning | direct | **D — unrelated** | Development/demo seeding of bundled assets. |
| PDF renderer child (`scripts/render-pdf.js`) | direct | **B — legitimately local** | Chromium needs real files; when its inputs move to object storage, `withLocalFile` is the seam it uses. |

---

## 6. Process lifecycle

**This was the one finding that affected correctness, not just future
migration cost.** The server installed no SIGTERM or SIGINT handler.

Every container platform stops a process by sending SIGTERM and waiting a
grace period before SIGKILL. Without a handler, in-flight requests were
cut off mid-response and the SQLite handle was never closed, leaving a
write-ahead log for whatever started next to replay. The image's
`exec node` also makes the process PID 1, where a signal with no installed
handler is ignored by the kernel outright — so the container would sit out
the entire grace period and die to SIGKILL anyway.

The fix is the ordinary containerised-service shutdown: stop accepting,
let accepted requests finish within a bounded grace period
(`OBV_SHUTDOWN_GRACE_MS`, default 10s), clear background timers, close the
database. Readiness reports `accepting: false` as soon as the signal
lands, so a load balancer stops sending traffic during the drain.

One subtlety worth recording: idle connections must be swept **repeatedly**
during the drain. A connection serving an in-flight request only becomes
idle when that request finishes, so a single sweep at the start never sees
it and shutdown waits out the whole grace period for a connection nobody
is using.

---

## 7. Findings by priority

| Priority | Finding | Disposition |
|---|---|---|
| **P0** | none | — |
| **P1** | No SIGTERM/SIGINT handling — dropped requests, unclean database close, PID-1 signal ignored | **Fixed.** |
| **P1** | Single-writer constraint undocumented and undetectable | **Fixed** (disclosed in log, readiness, `pilot:check`). |
| **P2** | Platform variables took precedence over generic ones and used three different commit names | **Fixed** — one boundary, generic wins, fallbacks preserved. |
| **P2** | Preview banner keyed off a hard-coded branch name | **Fixed** — opt-in via `OBV_PREVIEW`. |
| **P2** | Object-key resolution restated in several places | **Fixed** — one boundary; `auditPackage.ts` converted. |
| **P2** | ObjectStore contract was synchronous, exposed `fs.ReadStream` and a physical-path method | **Fixed** — async, generic `Readable`, path access only via the scoped `withLocalFile` lease; contract proven against a pathless in-memory double. |
| **P2** | Test harnesses treated `child.kill()` as instant termination | **Fixed** — `scripts/lib/proc.js: stopProcessAndWait()` waits for the actual exit event; seven suites converted. Graceful shutdown made `kill()` mean "drain started", and suites restarting a server against the same data directory were racing the WAL checkpoint. |
| **FUTURE** | SQLite → PostgreSQL | Documented in `POSTGRES_MIGRATION_MAP.md`. Not started. |
| **FUTURE** | Local artifacts → object storage | Boundary exists; remaining callers classified in §5; no data moved. |
| **FUTURE** | In-process scheduled dispatch under multiple instances | Needs a single-runner strategy once the app tier scales. |
| **NOT A PROBLEM** | Teams / WhatsApp / Anthropic naming their vendors | Correct: they are those vendors. |
| **NOT A PROBLEM** | Chromium in the image | Portable across any container host. |

---

## 8. Docker review

- **No Render dependency.** Nothing in the image references a platform.
- **No secrets in any layer.** All configuration is injected at run time.
- **Deterministic builds.** `npm ci` from the committed lockfile in both stages.
- **Writable data externalised.** Only `OBV_DATA_DIR` is written; the image is otherwise immutable.
- **Chromium portable.** Installed with its system libraries at a fixed path.
- **Runs as root — retained deliberately.** Platform volume mounts (Render disks, Azure Files) are commonly root-owned, and switching to a non-root UID risks an unwritable data directory on first boot of the pilot. Recorded as a hardening item to be done with a real mount to test against, not guessed at now. A future non-root image needs: a fixed UID/GID, `chown` of the mount at deploy time, and a Chromium sandbox check.

---

## 9. What was deliberately NOT done

Nothing was migrated. Specifically: no Azure resource was provisioned, no
PostgreSQL work was started, no evidence was moved to blob storage, no
Kubernetes or microservice was introduced, no Key Vault adapter was
written, and no governed workflow, authorization rule, tenancy boundary or
Evidence Ledger semantic was touched.
