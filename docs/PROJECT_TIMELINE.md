# OBV Project Timeline & Site Intelligence

One chronological history per project, showing exactly what happened,
when, who did it, what evidence exists, and how the project reached its
current state — so a lender, auditor, executive, contractor, or
regulator can understand a project without navigating dozens of pages.

> The project timeline is a read-only view of records OBV already holds.
> It never creates approvals, changes project state, releases funds, or
> replaces the governed workflows that authored these records. Advisory
> observations are labeled as such and are never decisions.

## Doctrine

The timeline is a **visualization and intelligence layer**, not a new
system of record:

- It **owns no tables**. Every event is derived on read from a record
  some governed subsystem already authored.
- It **performs no writes**. The layer contains no `INSERT`/`UPDATE`/
  `DELETE`, prepares no SQL of its own, and calls no approval, release,
  decision, or payment path. The route module has **no POST handler at
  all** — any non-GET to a timeline API is refused `405`.
- Every event is labeled **AUTHORITATIVE** or **ADVISORY**, and the two
  are never styled alike.
- It **never invents a timestamp**. Records without a usable time are
  dropped rather than guessed.

All four properties are asserted statically by the test battery, and the
read-only guarantee is proven at runtime: twenty-one authoritative
tables are byte-identical after exercising the entire surface.

## Timeline Engine

```
services/timeline/
  core.ts              error type, doctrine notice, role gates,
                       same-404 scoping, event construction,
                       deterministic ordering, filters, named views
  collectors.ts        14 subsystem collectors -> TimelineEvent[]
  aggregate.ts         project + portfolio reads, grouping, event
                       detail, relationship graph
  story.ts             Project Story, draw playback, executive playback
  insights.ts          advisory Timeline Intelligence
  siteIntelligence.ts  Site Intelligence panels, map layers, future
                       spatial capability declarations
  index.ts             the facade routes and pages import from
http/timelineRoutes.ts + view/timelinePages.tsx   /timeline
```

### Collected events

Fourteen collectors cover the governed subsystems: pilot launch and the
**configuration audit trail** (which carries `PROJECT_CREATED`,
`MILESTONE_ADDED`, and every other governed configuration change with
its actor), budget lines and change orders, milestones, permits +
governing code determinations + permit basis versions and corrections +
manual source verifications, inspections (requested / scheduled /
result), evidence (captured / uploaded / verified), Evidence
Intelligence findings and reviewer actions, Official Source retrievals /
changes / reviewer decisions / attached references, disputes, exceptions,
draws + approval requests and records + lender decisions, payment
instructions + banking confirmations, and audit packages.

Each collector degrades independently: a subsystem that is not
configured for a project yields no events instead of breaking the
history.

### Every event carries

`timestamp · actor · category · type · project · draw · milestone ·
affected record (table + id) · plain-language explanation · source link ·
authoritative/advisory status · severity · what changed`

### Determinism

Ordering breaks ties on **time, then category, then type, then the
synthetic event id**, so same-millisecond writes (common in seeded and
batch-written data) never reorder between runs. Grouping is
deterministic in every mode. The battery asserts stability under input
shuffling.

### Honesty about time

- The `projects` table stores **no creation timestamp**, so no
  `PROJECT_CREATED` event is fabricated. Story Mode opens with the
  earliest *recorded* activity and says exactly that. (For projects
  onboarded through the pilot flow, the real `PROJECT_CREATED` audit row
  supplies it.)
- Some records carry dates that have not arrived yet — a recorded permit
  expiry, a scheduled inspection. These appear on the timeline marked
  **"Upcoming — not yet happened"** and are excluded from Story Mode and
  playback. History and schedule are never conflated.
- Source read caps are **reported**, never silent: if a high-volume
  source is capped, the view says so.

## Views, filtering, grouping

Named views: everything · milestones · evidence · inspections · permits
& sources · financial · disputes & exceptions · reviewer activity. Plus
free-text search (title, explanation, type, actor), date range,
milestone/draw/actor filters, a result cap that keeps the **most recent**
window, and grouping by week, month, category, or milestone. A filtered
view always reports the unfiltered total so nothing looks hidden.

## Project Story Mode

Explains the project in plain language a non-technical lender can read —
"evidence was submitted, a duplicate invoice was flagged, a reviewer
investigated, an exception was recorded, the contractor corrected it,
the inspection passed, the draw was approved, the provider confirmed
settlement" — instead of listing rows. Routine bookkeeping is summarized
and counted rather than narrated, and every step links back to the event
(and record) that produced it.

## Playback

- **Draw playback** walks the governed lifecycle: requested → evidence
  submitted → evidence reviewed → official sources checked → inspection
  → exceptions → disputes → lender decision → payment instruction →
  provider confirmation. Stages resolve through **both** draw→milestone
  linkages (line items and explicit evidence links), and an open
  exception marks its stage `BLOCKED`.
- **Executive playback** replays the project period by period with a
  written narrative per frame and cumulative counts that never decrease.
  Long histories collapse into a readable number of frames.

## Timeline Intelligence

Eight advisory patterns, each reporting **the measurement and the
threshold behind it** so nothing is a black box: long approval delays,
repeated failed inspections, repeated disputes, evidence gaps, repeated
reviewer requests, permit delays, contractor response delays, and
inspection bottlenecks. Thresholds are published in `THRESHOLDS`.

These are observations for a human. They never approve, reject, block,
escalate, create a record, or make a judgement about any party.

## Site Intelligence

Fourteen composed panels — project health, budget, schedule, evidence
quality, permit status, inspection status, official source status,
contractor, risk level, open exceptions, disputes, draw status, payment
status, portfolio position — plus an executive summary and the advisory
observations. Every figure is read from an existing record; health is
composed from the panels and explains how. The contractor panel states
explicitly that OBV records participation and never rates integrity.

## Project map

Reuses the existing spatial engine's site boundary and route/segment
geometry, and adds record layers. **Evidence appears only where the
capturing device recorded a real GPS fix** — a missing fix is never
placed at a guessed point. Permits, inspections, and official-source
records have no coordinates of their own and are listed as
project-anchored records rather than invented locations.

## Future spatial boundaries

Seven provider-neutral capabilities are **declared interfaces only**:
drone imagery, satellite imagery, LiDAR, photogrammetry, volumetric
measurement, BIM models, and GIS layers. All are `DISABLED`, each states
what an implementation would require, and **no provider is connected, no
imagery is retrieved, and no computer-vision, photogrammetric, or
volumetric analysis is performed** in this build.

## Portfolio timeline

Activity across every project the caller can see, with a weekly activity
strip, per-project event counts and recent events, and links into each
project's timeline, story, site intelligence, and playback. The
Executive command center gains an advisory **Project history** band.

## Authorization & tenancy

All four roles may read the history of a project they can already see —
the timeline shows only what the caller could reach through the governed
pages. Every read is scoped by `authz.accessibleProjectIds`, and a
project (or draw, or event) the caller cannot see returns a plain `404`
that is **identical** to the response for one that does not exist.

## Export

CSV and JSON export serialize exactly what the caller can already read,
through the same gate as the page. No new data is exposed.

## Testing

`scripts/timeline-test.js` (registered in the runner): **157
checkpoints** across twelve sections — static read-only guards,
aggregation across every subsystem, ordering determinism including
same-millisecond ties, filtering/views/search/date ranges, all four
grouping modes, story mode (with the no-invented-timestamp assertion),
draw and executive playback, advisory insights, site intelligence + map
layers + spatial boundaries, authorization/tenancy/same-404 plus the
byte-identical read-only proof over twenty-one tables, large-timeline
performance (1,200+ synthetic events), the relationship graph, export,
and frontend rendering + HTTP authorization.

## Performance

The timeline is derived on read with no new tables and no new indexes. A
1,240-event project timeline builds in ~20ms; filtered reads ~13ms;
story mode and site intelligence stay well inside their budgets on the
same history. Per-source read caps bound the largest sources and are
reported when they apply.

## Known limitations

- Seeded demo projects carry no `config_audit` rows for project or
  milestone creation, so their stories open at the first *recorded*
  record. Projects onboarded through the pilot flow have the real
  creation events.
- Permits, inspections, and official-source records have no coordinates
  in the data model, so the map lists them as project-anchored records
  rather than placing them.
- The relationship graph is rendered as grouped lists rather than a
  drawn node graph; the data shape (`nodes`/`edges`) is ready for a
  visual renderer.
- Future spatial capabilities are interface declarations only.
- Executive playback collapses very long histories into a bounded number
  of frames; the full detail remains on the timeline itself.
