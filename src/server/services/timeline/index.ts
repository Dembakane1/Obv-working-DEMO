/**
 * Project Timeline & Site Intelligence — service facade. Routes and
 * pages import ONLY from here. Every export is role-gated and
 * tenant-scoped (or pure doctrine/config), and the whole layer is
 * read-only: it owns no tables and performs no writes.
 */
export {
  TimelineError,
  TIMELINE_NOTICE,
  canViewTimeline,
  assertTimelineViewer,
  requireVisibleProject,
  categoriesForView,
  VIEW_CATEGORIES,
  sortEvents,
  applyFilters,
  normalizeAt,
} from "./core";

export {
  projectTimeline,
  eventDetail,
  groupEvents,
  milestoneLabels,
  portfolioTimeline,
  relationshipGraph,
  pastEvents,
  upcomingEvents,
  type ProjectTimeline,
  type PortfolioTimeline,
  type PortfolioTimelineEntry,
} from "./aggregate";

export {
  projectStory,
  drawPlayback,
  executivePlayback,
  type ProjectStory,
  type DrawPlayback,
} from "./story";

export { timelineInsights, THRESHOLDS } from "./insights";

export {
  siteIntelligence,
  projectMapData,
  spatialReadiness,
  SPATIAL_CAPABILITIES,
  type SiteIntelligence,
  type SitePanel,
  type ProjectMapData,
  type MapLayerFeature,
} from "./siteIntelligence";
