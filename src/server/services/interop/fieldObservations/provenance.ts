/**
 * Evidence source provenance — the ONE place that answers "where did this
 * photo come from?" for every evidence item. Read-only.
 *
 *   OBV Capture                 — no provenance row: the photo entered
 *                                 through the field PWA / draft flow.
 *   External Field Observation  — a reviewer accepted an imported
 *                                 observation; the row names the provider,
 *                                 external record id, collector and the
 *                                 source's own timestamp and coordinates.
 *
 * Provenance is never rewritten: the row is insert-only and the label is
 * derived from it on every read.
 */
import * as interopRepo from "../../../db/interopRepo";
import type { EvidenceProvenance, EvidenceSourceLabel } from "../../../../shared/types";

export const OBV_CAPTURE_LABEL = "Source: OBV Capture";

export function sourceLabelFor(prov: EvidenceProvenance | null): EvidenceSourceLabel {
  if (!prov) {
    return {
      origin: "OBV_CAPTURE",
      label: OBV_CAPTURE_LABEL,
      providerLabel: null,
      externalObservationId: null,
      collector: null,
      sourceObservedAt: null,
    };
  }
  const provider = prov.providerLabel ?? providerDisplayName(prov.sourceSystem);
  return {
    origin: "EXTERNAL_FIELD_OBSERVATION",
    label: `Source: External Field Observation · Provider: ${provider}`,
    providerLabel: provider,
    externalObservationId: prov.externalObservationId,
    collector: prov.collector,
    sourceObservedAt: prov.sourceObservedAt,
  };
}

/** Source label for one evidence item (OBV Capture when no provenance
 *  row exists). Never throws: a provenance read failure reads as the
 *  conservative "unknown origin" rather than as a false OBV Capture. */
export function evidenceSourceLabel(evidenceItemId: string): EvidenceSourceLabel {
  try {
    return sourceLabelFor(interopRepo.getEvidenceProvenance(evidenceItemId));
  } catch {
    return {
      origin: "OBV_CAPTURE",
      label: "Source: not determinable (provenance read failed)",
      providerLabel: null,
      externalObservationId: null,
      collector: null,
      sourceObservedAt: null,
    };
  }
}

export function evidenceProvenance(evidenceItemId: string): EvidenceProvenance | null {
  return interopRepo.getEvidenceProvenance(evidenceItemId);
}

export function providerDisplayName(sourceSystem: EvidenceProvenance["sourceSystem"]): string {
  switch (sourceSystem) {
    case "KOBOTOOLBOX": return "KoBoToolbox";
    case "ODK": return "ODK";
    case "GEMS_STYLE": return "GEMS-style field platform";
    default: return "External field-data system";
  }
}
