# Timeline & Site Evidence (the Digital Twin maturity path)

A strictly additive **visualization layer** inside the Project Timeline. The
product surface is named **Timeline & Site Evidence**: a spatial project
record — chronology on the left, site evidence in the center, the selected
record's explanation on the right. It renders an interactive isometric site
scene, stage progress, evidence pins, playback, replay, and coverage metrics —
all derived on read from records the governed subsystems already hold.

OBV does not claim a "Digital Twin" as a current product: GPS-pinned evidence
over recorded geometry is a spatial project record, not a twin. The twin is
the **maturity path** this workspace is the first stage of (see
[Digital Twin maturity path](#digital-twin-maturity-path) below).

**Doctrine.** The twin owns no tables and performs no writes of any kind. It
never changes evidence, inspections, approvals, payments, project progress, or
official-source records, and it never becomes the system of record — **the
Timeline remains the authoritative interface.** Its route module has no POST
handler; every non-GET is refused with 405.

## What is drawn, and from where

| Scene content | Source of truth | Placement rule |
| --- | --- | --- |
| Site boundary | `projects.site_boundary` (recorded geofence) | Drawn only when recorded |
| Route / stage geometry | `spatial_features` ROUTE / SEGMENT rows | Drawn only when recorded |
| Evidence pins | `evidence_items` with a **real GPS fix** | Items without GPS are listed per stage, never placed |
| Inspection records | `jurisdictional_inspections` | **Never placed** — the record stores no coordinates, and milestone geometry is the milestone's location, not the inspection's. Listed in the dock with the milestone linkage stated |
| Permits, official records | `permits`, `official_source_records` | **Anchored dock** — no coordinates exist, so none are invented |
| Advisory markers | Evidence Intelligence signals + plain record facts | Drawn at the subject's recorded GPS when it exists; listed otherwise |

The scene lives in a local frame (metres east/north of the site centroid,
equirectangular over the recorded coordinates), so the scale bar and every
displayed distance are real measurements between recorded positions. When a
project has no recorded geometry at all, the scene is **degraded**: it says so
and renders the record lists, inventing nothing.

## Construction progress

Stage fills show the **recorded governance lifecycle** — the milestone's
position in `NOT_STARTED → PENDING_EVIDENCE → UNDER_REVIEW → VERIFIED →
APPROVED → RELEASED` — and every surface that shows them says "not a physical
measurement". Overall completion is the tranche-weighted share of RELEASED
milestones. Nothing is estimated and nothing is projected.

## Timeline synchronization

Every timeline event row (and the event detail page) carries a link into the
twin with `?focus=<eventId>`. The scene ships a sync map (event id → scene
element) built from real record correspondences: an evidence event highlights
its own pin, a milestone-linked event highlights its stage geometry, and a
project-level event highlights the boundary. Selection in the twin opens a
read-only detail drawer.

## Construction playback

Playback **replays the recorded timeline** — each step is exactly one recorded
event, in the timeline's deterministic order, with future-dated records
excluded. It never simulates, interpolates, or invents a frame. Oversized
histories are capped at a stated number of most-recent steps and report the
true total.

## Authorization

Inherited, never widened. Gated content consults the owning subsystem's own
predicate (one source of truth per gate): Evidence Intelligence signals and
metadata need `canViewEvidenceIntel`, official-source records need
`canViewSources`, and the payments layer needs the `VIEW_PROJECT_ACCOUNT`
banking capability. Tenant scoping is same-404 through the timeline core: an
inaccessible project, pin, or API path is indistinguishable from a nonexistent
one.

## Surfaces

- **Page** `/timeline/twin/:projectId` — scene, layers, stage progress,
  playback, detail drawer, anchored dock, advisory panel.
- **APIs** (GET only): `/api/twin/scene/:id`, `/api/twin/playback/:id`,
  `/api/twin/pin/:projectId/:evidenceId`, `/api/twin/coverage/:id`,
  `/api/twin/snapshots`, `/api/twin/providers`.
- **Site Intelligence** gains a coverage band: completion %, evidence /
  GPS / inspection / official-source coverage (each with numerator and
  denominator), risk density, and a weekly activity heatmap.
- **Portfolio timeline** gains miniature twins (recorded boundary + stage
  states) linking to each project's full Timeline.
- **Entry links** from milestone detail and the Evidence Intelligence
  evidence viewer.

The client script (`/js/twin.js`) is a self-contained progressive
enhancement: layer toggles, selection, pan/zoom, and playback. It issues GET
requests only.

## Timeline & Site Evidence workspace

The `/timeline/twin/:projectId` page is the three-pane workspace over the
machinery above:

- **Left — governed timeline.** Newest-first stream of the project's derived
  events, each carrying a **truth class** derived centrally in the event
  constructor: `GOVERNED_FACT` (asserts a governed state or decision),
  `HISTORICAL_EVENT` (something happened, no state assertion), or
  `ADVISORY_SIGNAL` (advisory, never a decision). Compact truth-class
  filters and a "Located only" toggle are client-side visibility over
  already-authorized rows. Events derived from a record with stored
  coordinates carry `spatial` (copied verbatim, never derived — a record
  without coordinates carries null; the project's location is never used as
  a stand-in).
- **Center — site evidence.** The recorded-geometry scene, unchanged in its
  honesty rules. The header states the count of GPS-located evidence records,
  or "No spatial evidence recorded" when there are none.
- **Right — the selected record.** `?event=<eventId>` (or the older
  `?focus=`) server-renders the event's stored record. For a
  `READINESS_TRANSITION` event (derived from the readiness machine's
  immutable `draw_events` rows) the inspector strictly separates **"At the
  time (recorded)"** — only what the stored row carries: from → to; the row
  stores no cause, and the inspector says "Cause not recorded in this
  historical event" rather than inventing one — from **"Current linked
  state"** — live draw status, live readiness, and the deterministic
  CURRENT NEXT ACTION, labeled as of this page render. Historical
  transitions are never described with today's blockers.
- **Project Replay.** A client-side window over the rendered, authorized
  record: "Recorded events through: T" hides stream rows and record markers
  whose OWN recorded timestamps are after T (structural geometry stays),
  clears the selection, and updates the visible count. The replay window is
  exactly the shown stream window (the most recent `STREAM_CAP` events);
  when the project has more, the page discloses "most recent N of M" with
  the window's dates and points at the full Timeline for earlier history —
  the scrubber never spans events the pane did not render, and nothing is
  labeled a "full record". Quick ranges All / "30d ago" / "7d ago" rewind
  relative to the latest event in the window that actually happened,
  clamped to the window's start. Replay never recomputes historical
  readiness — there is no readiness claim in a replay window beyond the
  transitions actually recorded in it.
- **Current context strip.** Recorded location (the stored project field),
  latest recorded activity, spatial-evidence count, and per open draw the
  **CURRENT DRAW STATE** (status, live readiness or "evaluation
  unavailable", requested amount) and **CURRENT NEXT ACTION** from the
  existing deterministic engine.

## Digital Twin maturity path

The deep value of a construction twin is not 3D graphics — it is a **spatial +
temporal + provenance + governed-state architecture**: every record placed
where it was recorded, ordered when it was recorded, traceable to who recorded
it, and bound to the governed state it affected. 3D is a visualization option
on top of that architecture, not the architecture. OBV's staged path:

1. **Stage 1 — Spatial project record (CURRENT).** Recorded geometry, GPS
   evidence pins, governed timeline synchronization, replay of recorded
   history, honest empty states. Everything derived on read; nothing
   invented. This is what ships today.
2. **Stage 2 — Site-plan & document georeferencing (FUTURE).** Recorded
   site-plan overlays and georeferenced drawings, only where a plan document
   with a stored reference frame exists.
3. **Stage 3 — Reality capture ingestion (FUTURE).** Drone imagery / LiDAR /
   photogrammetry through the disabled provider boundaries below, stored as
   evidence with capture provenance — never as a substitute for governed
   verification.
4. **Stage 4 — 3D model correlation (FUTURE).** BIM/IFC model linkage where a
   model exists, correlated to milestones and evidence — visualization of
   governed state, never a second source of truth.
5. **Stage 5 — Continuous twin (FUTURE).** Ongoing capture streams reconciled
   against the governed record, with the same doctrine: the twin owns no
   data, performs no writes, and the Timeline remains the authoritative
   interface.

Only Stage 1 exists in the product today; every later stage is a disabled,
labeled boundary. No IoT/sensor telemetry is part of this path's current
scope.

## Future provider boundaries

Cesium, ArcGIS, Mapbox, Google Maps, DroneDeploy, Pix4D, Matterport, Bentley
iTwin, and Autodesk Construction Cloud are declared as **disabled provider
boundaries** (`TWIN_PROVIDER_SPECS`) — named interfaces a future adapter could
implement. None is connected or contacted; no imagery is retrieved; no
reality-capture or vision analysis is performed anywhere in OBV.

## Tests

`scripts/twin-test.js` (123 checkpoints): static read-only guards, scene
correctness over recorded geometry, honesty (lifecycle basis, degraded
scenes, caps), authorization inheritance with positive controls, sync
integrity, playback-equals-history, pin detail distances and same-404,
coverage arithmetic, snapshot tenancy, a byte-identical proof over 22 tables,
large-history performance, and frontend rendering + HTTP authorization.
