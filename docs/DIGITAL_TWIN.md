# Digital Twin

A strictly additive **visualization layer** inside the Project Timeline. The
twin renders an interactive isometric site scene, stage progress, evidence
pins, playback, and coverage metrics — all derived on read from records the
governed subsystems already hold.

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
| Inspection markers | `jurisdictional_inspections` | Placed at the midpoint of the milestone's recorded geometry; dock otherwise |
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
