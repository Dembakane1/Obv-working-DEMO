/**
 * Future twin provider boundaries — declared interfaces ONLY.
 *
 * No provider is implemented, contacted, configured, or simulated. No
 * imagery is retrieved and no reality-capture or vision analysis is
 * performed. These specs exist so a future adapter has a named boundary
 * to implement; every one is DISABLED and the UI says so.
 */
import type { TwinProviderSpec } from "../../../shared/types";

export const TWIN_PROVIDER_SPECS: TwinProviderSpec[] = [
  {
    key: "cesium",
    displayName: "Cesium",
    category: "GIS",
    status: "DISABLED",
    description: "3D geospatial rendering of the recorded site geometry.",
    requires: ["Provider account and terms review", "Tile/terrain licensing", "Egress approval"],
  },
  {
    key: "arcgis",
    displayName: "ArcGIS",
    category: "GIS",
    status: "DISABLED",
    description: "Authoritative jurisdiction and parcel layers under the recorded boundary.",
    requires: ["Provider account and terms review", "Layer licensing", "Egress approval"],
  },
  {
    key: "mapbox",
    displayName: "Mapbox",
    category: "GIS",
    status: "DISABLED",
    description: "Base-map tiles under the recorded scene.",
    requires: ["API token governance", "Terms review", "Egress approval"],
  },
  {
    key: "google-maps",
    displayName: "Google Maps",
    category: "GIS",
    status: "DISABLED",
    description: "Base-map and imagery tiles under the recorded scene.",
    requires: ["API token governance", "Terms review", "Egress approval"],
  },
  {
    key: "dronedeploy",
    displayName: "DroneDeploy",
    category: "IMAGERY",
    status: "DISABLED",
    description: "Drone flight imports rendered as a dated, provider-attributed overlay.",
    requires: ["Flight authorization records", "Provider account", "Imagery retention policy"],
  },
  {
    key: "pix4d",
    displayName: "Pix4D",
    category: "REALITY_CAPTURE",
    status: "DISABLED",
    description: "Photogrammetry outputs (orthomosaic, point cloud) as read-only overlays.",
    requires: ["Capture provenance records", "Provider account", "Storage policy"],
  },
  {
    key: "matterport",
    displayName: "Matterport",
    category: "REALITY_CAPTURE",
    status: "DISABLED",
    description: "Interior capture walkthroughs linked from evidence records.",
    requires: ["Capture provenance records", "Provider account", "Access policy"],
  },
  {
    key: "bentley",
    displayName: "Bentley iTwin",
    category: "BIM",
    status: "DISABLED",
    description: "Design-model alignment against the recorded geometry.",
    requires: ["Model ownership and licensing", "Provider account", "Version governance"],
  },
  {
    key: "autodesk",
    displayName: "Autodesk Construction Cloud",
    category: "BIM",
    status: "DISABLED",
    description: "Design and coordination models beside the recorded record set.",
    requires: ["Model ownership and licensing", "Provider account", "Version governance"],
  },
];

export function twinProviderReadiness(): {
  providers: TwinProviderSpec[];
  implemented: number;
  notice: string;
} {
  return {
    providers: TWIN_PROVIDER_SPECS,
    implemented: 0,
    notice:
      "Provider boundaries are declared interfaces only. None is connected; no imagery is retrieved; " +
      "no reality-capture or vision analysis is performed anywhere in OBV.",
  };
}
