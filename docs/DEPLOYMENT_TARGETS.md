# OBV Deployment Targets

Three architecture stages. **Stage A is what runs today**; B and C are
reference architectures, not provisioned environments. No Azure or private
infrastructure exists for OBV at the time of writing, and none is required
to run the product.

---

## A. Current pilot — the only supported deployment today

```
        internet
           │  TLS terminated by the platform
    ┌──────▼──────────────────────┐
    │  ONE OBV container          │   same image as every other stage
    │  node:22 + Chromium         │
    │  PORT, OBV_DATA_DIR         │
    └──────┬──────────────────────┘
           │
    ┌──────▼──────────────────────┐
    │  persistent volume          │   obv.db · worm/ · uploads/
    │  mounted at OBV_DATA_DIR    │   reports/ · audit-packages/
    └─────────────────────────────┘
           │
    Postmark (transactional email) · OBV native identity
    backups written out of band and copied off-box by the operator
```

- **Exactly one instance.** Not a recommendation — a correctness
  constraint. See `CLOUD_PORTABILITY.md` §4.
- Requires: a container host, a persistent volume, `OBV_DATA_DIR`, a
  Postmark token and sender, `OBV_SESSION_SECRET`, `OBV_ENVIRONMENT`.
- Requires **no** cloud account, managed database, object store or secret
  manager.

---

## B. Azure scale target

Reached when the pilot needs more than one application instance, real HA,
or immutable artifact retention enforced by the platform.

### Required for scale

| Component | Azure service | Why required |
|---|---|---|
| Application runtime | Container Apps (or AKS) | multiple replicas of the same image |
| Database | Azure Database for PostgreSQL Flexible Server | the gate on horizontal scale — see `POSTGRES_MIGRATION_MAP.md` |
| Object storage | Azure Blob Storage | replicas cannot share a mounted volume safely |
| WORM | Blob immutability policy / legal hold | the retention guarantee `ObjectClass.IMMUTABLE` expresses |
| Ingress / TLS | Container Apps ingress, or Application Gateway | terminate TLS, route to replicas |

### Optional Azure-native enhancements

These improve operations. **None is required, and none may become a
dependency of application logic.**

| Component | Azure service | Alternative that must keep working |
|---|---|---|
| Secrets | Key Vault | environment variables — the universal fallback |
| Monitoring | Azure Monitor / Application Insights | stdout logs + `/api/health`, `/api/ready` |
| Email | Azure Communication Services | Postmark, SMTP, or any `EmailProvider` adapter |
| Identity | Microsoft Entra ID | OBV native passwordless identity |
| AI | Azure OpenAI | the existing advisory provider, or none |
| Edge | Front Door / CDN | direct ingress |

**OBV must not become Azure-locked.** The test battery asserts that no
Azure SDK can enter `src/`, and that health and readiness name no vendor.

---

## C. Sovereign / private cloud target

For a deployment that must run inside a customer's or a national
jurisdiction's own infrastructure.

| Capability | Implementation |
|---|---|
| Ingress / TLS | the operator's load balancer or ingress controller |
| Runtime | any container orchestrator |
| Database | PostgreSQL, self-operated |
| Object storage | S3-compatible (MinIO, Ceph, or a national provider) |
| WORM | S3 Object Lock in compliance mode |
| Secrets | HashiCorp Vault or the operator's KMS |
| Monitoring | the operator's logging and metrics stack |
| Email | the operator's transactional mail relay (SMTP adapter) |
| AI | optional private model, or advisory analysis disabled entirely |
| Identity | OBV native identity, or the operator's OIDC provider |

There is **no OBV-operated cloud**. If one is ever built, it is Stage C
with OBV as the operator — not a distinct product, and not something this
document should describe as existing.

---

## Capability matrix

| Capability | Current implementation | Abstraction status | Azure target | Private target | Migration required? |
|---|---|---|---|---|---|
| Application runtime | Docker, 1 instance | **A** — plain container | Container Apps / AKS | any orchestrator | **No** — same image |
| Database | SQLite via repo layer | **B** — contained, sync API | PostgreSQL Flexible Server | PostgreSQL | **Yes** — data + async repo |
| Object storage | LocalObjectStore over volume | **C** — boundary defined, partially adopted | Blob Storage | S3-compatible | **Yes** — data copy + adapter |
| WORM / immutability | write-once + ledger hash chain | **A** — expressed as a guarantee | Blob immutability policy | S3 Object Lock | adapter only |
| Secrets | environment variables | **A** | Key Vault → env | Vault → env | **No** |
| Identity | OBV passwordless | **A** | Entra ID (optional) | OIDC (optional) | **No** |
| Email | Postmark behind `EmailProvider` | **A** — 5 free adapter positions | ACS / Graph / SMTP | private relay | adapter only |
| AI | Anthropic, advisory only | **A** | Azure OpenAI | local model / off | adapter only |
| Notifications | Teams, WhatsApp, email | **E** — intentionally vendor-specific | unchanged | unchanged | **No** |
| Monitoring | stdout + health/ready | **A** | Azure Monitor | operator stack | **No** |
| Backups | `VACUUM INTO` + sha256 verify | **B** — concept portable, mechanism engine-specific | managed backup / PITR | `pg_dump` / pgBackRest to WORM | with the database |
| Ingress / TLS | platform-terminated | **A** | Container Apps / App Gateway | operator LB | **No** |

**A** = already provider-neutral · **B** = acceptable coupling ·
**C** = boundary created here · **E** = intentionally vendor-specific

---

## What moving actually involves

| Stage | Work |
|---|---|
| A → A on a different host | Point the image at a new volume, set the same environment. Nothing else. |
| A → B | The PostgreSQL migration, an Azure Blob adapter, and infrastructure. **No change to lender workflows, verification, approvals, the Evidence Ledger or governance logic.** |
| B → C | Swap managed services for self-operated equivalents. The application does not change. |

The three environment variables that matter in every stage are the same:
`PORT`, `OBV_DATA_DIR` (or its object-store successor), and
`OBV_PUBLIC_BASE_URL`.
