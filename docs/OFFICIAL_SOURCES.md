# OBV Official Source Connectors Platform

Reduces manual permit, inspection, enforcement, property, and
contractor-license lookups while preserving every existing human-review
and historical-record control.

> OBV retrieves and records official-source information as evidence for
> authorized human review. External records may be incomplete, delayed,
> changed, or incorrectly matched. OBV does not issue permits, perform
> government inspections, grant licenses, provide legal interpretations,
> approve draws, or automatically authorize payment.

## Core doctrine

External government and licensing systems are **information sources, not
OBV's source of truth**. The required lifecycle is:

```
official-source retrieval
  -> immutable raw snapshot          (append-only, SHA-256 hashed)
  -> normalized candidate record     (verbatim source values preserved)
  -> match / confidence evaluation   (explainable; never auto-linked when
                                      ambiguous or conflicting)
  -> reviewer confirmation           (Official Source Review Queue)
  -> authoritative OBV record        (ONLY through the existing governed
                                      DMV / permits / exceptions commands)
```

A connector never automatically approves or rejects a draw, marks an
official inspection passed, alters a governing permit basis, clears an
exception, releases a dispute hold, creates a lender decision or payment
instruction, moves funds, or overwrites a historical record. These are
enforced statically (the test battery greps the layer for authoritative
writes) and at runtime (authoritative tables are byte-identical under
retrieval).

## Architecture

```
services/officialSources/
  core.ts        OfficialSourceError, doctrine notice, role gates,
                 config (endpoint/credential env REFERENCES), redaction,
                 freshness labeling
  egress.ts      the ONLY outbound-HTTP path: host allowlists, DNS
                 pinning, redirect validation, size/time caps
  connectors/    provider-neutral contract + adapters:
    types.ts       sourceMetadata / healthCheck / search / fetchRecord /
                   fetchChanges / normalize / validate / buildProvenance
    mock.ts        deterministic in-process mock (demo/tests; labeled
                   "not a government system")
    arcgisOpenData.ts  one adapter for every Open Data DC dataset
    ddotTops.ts    DDOT TOPS documented Web API (Bearer license key)
    manualBoundary.ts  MANUAL_VERIFICATION_REQUIRED boundaries
    index.ts       the DC source map + registry
  registry.ts    source registry service (secret-free views, health)
  retrieval.ts   retrieval -> snapshot -> candidates (mapToCandidate)
  matching.ts    explainable match engine
  changes.ts     deterministic change detection
  polling.ts     refresh orchestration: rate caps, retries, circuit
                 breaker, dead letters, pause, scheduled-poll gate
  review.ts      Official Source Review Queue + governed confirmations
  evidenceLink.ts  advisory Evidence Intelligence signals
  analytics.ts   tenant-scoped portfolio analytics
db/officialSourcesRepo.ts   all SQL; append-only snapshots + events
http/officialSourceRoutes.ts + view/officialSourcePages.tsx  /official-sources
```

Tables: `official_sources` (registry), `source_snapshots` (append-only),
`source_candidates`, `source_matches`, `source_change_events`,
`source_review_items` + `source_review_events` (append-only),
`source_poll_state`, `source_dead_letters`.

## Source classification (honesty rules)

Every source is classified by its ACTUAL officially supported access
method: `OFFICIAL_API`, `OFFICIAL_OPEN_DATA`, `OFFICIAL_DOWNLOAD`,
`OFFICIAL_PORTAL_MANUAL`, `OFFICIAL_WEBHOOK`, `UNAVAILABLE`.

- An official portal is **never scraped**. A source without a documented
  API or published dataset is an explicit manual boundary: every
  connector method returns `MANUAL_VERIFICATION_REQUIRED` with portal
  instructions, and the reviewer's manual lookup is recorded through the
  governed DMV source-verification command — exactly as before.
- Live retrieval for dataset/API sources requires the operator to
  configure the **documented official endpoint** (`OBV_SOURCE_<ID>_URL`),
  copied from the source's official API page. Endpoints are never
  guessed; an unconfigured source REFUSES automated retrieval and falls
  back to manual instructions.
- The deterministic mock connector is unmistakably labeled "not a
  government system" and exists for tests and demos only.
- Live government systems are never a CI dependency: the battery runs
  against the mock connector and a deterministic local HTTP server.

## DC source map (v1)

| Source | Agency | Classification | Access method |
| --- | --- | --- | --- |
| Building Permits | DOB | `OFFICIAL_OPEN_DATA` | Open Data DC dataset query API (operator-configured endpoint) |
| Certificates of Occupancy | DOB | `OFFICIAL_OPEN_DATA` | Open Data DC dataset query API |
| Inspection records | DOB | `OFFICIAL_PORTAL_MANUAL` | Scout portal — manual verification boundary |
| Enforcement / stop-work | DOB | `OFFICIAL_PORTAL_MANUAL` | Scout portal — manual verification boundary |
| Basic Business Licenses | DLCP | `OFFICIAL_OPEN_DATA` | Open Data DC dataset query API |
| Professional & contractor licenses | DLCP | `OFFICIAL_PORTAL_MANUAL` | Scout / Access DC — manual verification boundary |
| Public-space construction & occupancy permits | DDOT | `OFFICIAL_API` | TOPS documented Web API (registered license key, Bearer auth) |
| Property / parcel references | OCTO | `OFFICIAL_OPEN_DATA` | Open Data DC dataset query API |

References: Open Data DC dataset API pages (building permits,
certificate of occupancy, basic business licenses), the DDOT TOPS API
guide (`topsapi.ddot.dc.gov/Help`), DOB online resources (Scout), and
the DLCP license-verification pages. The MAR 2 address web service is a
documented candidate for a future property-reference adapter.

## Raw snapshots

Every retrieval — success, empty, error, refused, or manual — writes an
immutable snapshot first: source, connector version, request type,
sanitized lookup parameters, timestamps (retrieved + source-reported),
HTTP status, content type, raw payload (large payloads under
`uploads/source-snapshots/`), SHA-256 of the payload, allowlisted
provenance headers only, cursor info, actor, tenant scope, retention
class, and outcome. Snapshots are append-only; corrections are new
snapshots. **Secrets, authorization headers, cookies, and tokens are
never stored in snapshots, logs, errors, or dead letters** (defense in
depth: redaction runs on every error path, and the battery greps the
database for planted secrets).

## Normalization

Candidates keep the **source's verbatim value alongside OBV's normalized
value** for every field — original terminology is never discarded.
Dataset schemas drift: field mapping works from candidate column lists,
and a missing expected field records a normalization warning instead of
inventing a value.

## Matching

The engine compares permit/license numbers (normalized identifiers),
addresses (house-number-aware: only differing house numbers count as a
genuine mismatch — free-text project locations are "not comparable",
never a conflict), party names, permit types, and dates. Verdicts:
`EXACT_MATCH`, `HIGH_CONFIDENCE_MATCH`, `POSSIBLE_MATCH`, `AMBIGUOUS`,
`NO_MATCH`, `CONFLICT` — each with a confidence score, reason codes, the
exact fields compared, the differences, and a reviewer recommendation.
Equally strong multi-target hits downgrade to `AMBIGUOUS`; ambiguous and
conflicting records are **never auto-linked** and refuse attachment.
Matching only ever evaluates entities in the caller's accessible
projects — an inaccessible project's records are never compared, counted,
or disclosed.

## Review queue

Queue events cover new candidates, status changes, failed inspections,
reinspections, enforcement/stop-work wording, license
expiry/suspension/not-found, contractor-name mismatches, property
mismatches, record disappearance, source conflicts, ambiguity, source
unavailability, and connector auth failures. Each item shows the
project, the affected OBV record, the retrieved record (side-by-side),
differences, the raw snapshot, match confidence, the suggested action,
and blocking implications if promoted.

Reviewer actions (funder representative / compliance reviewer):

- **Confirm & attach** → `permits.recordOfficialSource` (+ optional
  `dmvCompliance.recordSourceVerification`) — the governed commands with
  their own roles, referential validation, and audit;
- **Reject**, **Defer**, **Request manual verification**;
- **Record discrepancy** → a governed DMV source verification
  documenting the disagreement;
- **Promote to exception** → `exceptions.createManualException`.

Permit-basis corrections and official inspection results stay in the
existing DMV compliance screens (versioning, finalization rules, draw
pinning, and historical-package guarantees unchanged); a confirmed
attachment simply becomes available as backing evidence there. The
connector layer never writes those tables.

## Change detection

Deterministic diffs between the latest two candidate normalizations of
one external record, quoting the source's verbatim wording on both
sides. Stop-work/revocation/suspension wording classifies HIGH severity;
**a disappeared record is labeled `RECORD_UNAVAILABLE` — never inferred
revoked** — until a reviewer checks the portal. Change events are
idempotent.

## Polling & resilience

No always-running daemon. Manual refresh (record / source / project /
portfolio) is an explicit authorized action; page loads never trigger
retrieval (the UI shows cached state with freshness labels). Scheduled
polling is an external invocation of the poll API and **refuses until
`OBV_SOURCES_POLLING_ENABLE` is set**. Per source: client-side
rate caps, retry with exponential backoff + jitter, a circuit breaker
after consecutive failures, a dead-letter queue with reviewer
requeue/discard, pause/resume, and maintenance status. A connector
failure never blocks manual verification or draw workflows.

## Freshness

Every surfaced record carries its source, last-retrieved and
source-reported times, age, connector health, verification method, match
confidence, and reviewer-confirmation status, labeled in plain language:
"Live official API", "Official open-data snapshot", "Official portal
lookup", "Manually verified official record", "Cached official record",
"Source temporarily unavailable", "Human confirmation required". Cached
or manually recorded data is never called "live".

## Security

The egress client is the only outbound path: strict per-source host
allowlists (no user-supplied URLs, ever), HTTPS-only in production, no
embedded credentials, DNS resolution validated address-by-address and
**pinned** to the validated IP (rebinding defense), redirects surfaced
not followed (same-host HTTPS re-validated, max 2; cross-host refused),
streamed response-size caps, request timeouts, uncompressed transfer (no
decompression lever), content-type validation, allowlisted provenance
headers, credential redaction on every error path, tenant-scoped queries
and caches, service-level authorization, and same-404 object access.
Credentials live in environment variables named by the registry —
values are never stored, logged, or displayed, and the connector layer
has no access to banking credentials.

## Evidence & Portfolio Intelligence

Official-source snapshots and changes are evidence inputs: conflicts,
record disappearance, enforcement wording, and license inconsistencies
record **advisory** Evidence Intelligence signals (never "fraud", never
an automatic exception) that flow into the existing EI review queue.
Portfolio Intelligence gains a tenant-scoped advisory band and analytics:
permit official-record coverage, source freshness, enforcement/license
alerts, projects with unresolved conflicts, review backlog, average
time-to-resolution, and connector health by jurisdiction.

## Testing

`scripts/official-sources-test.js` (registered in the runner):
144 checkpoints across 11 sections — static doctrine guards, registry
classification and configuration gating, the snapshot->candidate
lifecycle with hash verification and verbatim preservation, snapshot
immutability and idempotent re-retrieval, explainable matching
(exact/conflict/ambiguous), tenant isolation and same-404, change
detection including non-inferred disappearance, the reviewer workflow
through the governed commands (exactly-once, role-gated), authoritative
non-mutation under retrieval, resilience and egress security over a
deterministic local HTTP server (drift, malformed, size caps, redirect
attacks, SSRF units, secret redaction, retries, circuit breaker, dead
letters, rate limits, cursors, poll gating), and frontend rendering +
HTTP authorization.

## Operational runbook

1. **Onboard a source**: add its connector (or dataset config), verify
   the official documentation, classify honestly, register allowed
   hosts, and seed the registry (automatic at startup).
2. **Configure**: set `OBV_SOURCE_<ID>_URL` from the official API page
   (and the credential env for keyed APIs). Run a health check from the
   source detail page.
3. **Operate**: refresh explicitly (or enable scheduled polling), watch
   the review queue, resolve dead letters, pause sources under
   maintenance.
4. **Rotate credentials**: change the env var value and restart — no
   stored secrets exist.

## Known limitations

- Only the deterministic mock retrieves without configuration; live DC
  retrieval requires operator-configured endpoints/credentials by
  design (no guessed endpoints, no live-government CI dependency).
- DOB inspections/enforcement and DLCP professional licenses have no
  supported automated access method and remain manual boundaries.
- Dataset field mappings are tolerant candidate lists; a dataset schema
  change surfaces as normalization warnings until the config is updated.
- Address matching is conservative by design and treats free-text
  locations as "not comparable" rather than guessing.
- Webhook-classified sources (`OFFICIAL_WEBHOOK`) are a declared
  category with no DC implementation yet.
