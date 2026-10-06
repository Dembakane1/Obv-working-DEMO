/**
 * Infrastructure Interoperability views — the project-scoped
 * "Infrastructure Data" area: OC4IDS export (preview, validation, export
 * history) and External Field Observations (import, review, decisions).
 *
 * Every surface repeats the doctrine notices so no reader mistakes
 * disclosure data for verification, or an imported observation for
 * evidence. "Verified" is never used for an observation; an export is
 * called READY only when the service says it validates. No secret value
 * ever reaches a view model.
 */
import { h, Fragment, renderDocument, type Child, type VNode } from "./jsx";
import {
  AppShell,
  AboutView,
  DenseFacts,
  DensePanel,
  DenseTable,
  KpiRail,
  NavContext,
  TechnicalHash,
  WorkHeader,
  Workbench,
  WorkspaceTabs,
  enumLabel,
} from "./components";
import { icons } from "./icons";
import type {
  FieldObservationImport,
  InteropExportRecord,
  InteropProviderSpec,
  Project,
} from "../../shared/types";
import type { ObservationDetail, ObservationListRow, Oc4idsPreview } from "../services/interop";

export interface InteropNotice {
  kind: "ok" | "err";
  text: string;
}

const STATUS_TONE: Record<string, string> = {
  READY: "ok", INCOMPLETE: "warn", NOT_CONFIGURED: "neutral", INVALID: "bad",
  VALID: "ok",
  UNVERIFIED: "warn", ACCEPTED: "ok", REJECTED: "neutral", DEFERRED: "neutral",
  DECLARED_PROJECT: "ok", REFERENCE_MATCH: "ok", REVIEWER_ASSIGNED: "ok", AMBIGUOUS: "warn", NO_MATCH: "neutral",
  NOT_CONNECTED: "dim",
};
const STATUS_LABEL: Record<string, string> = {
  READY: "Ready", INCOMPLETE: "Incomplete", NOT_CONFIGURED: "Not configured", INVALID: "Invalid",
  UNVERIFIED: "External observation — unverified", ACCEPTED: "Accepted as evidence", REJECTED: "Rejected", DEFERRED: "Deferred",
  NOT_CONNECTED: "Not connected",
};

function chip(value: string): Child {
  return <span className={`chip ${STATUS_TONE[value] ?? "neutral"}`}>{STATUS_LABEL[value] ?? enumLabel(value)}</span>;
}
function when(iso: string | null | undefined): string {
  return iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "—";
}
function Notice(props: { notice: InteropNotice | null | undefined }): VNode {
  if (!props.notice) return <></>;
  return (
    <div className={`attn ${props.notice.kind === "ok" ? "info" : "bad"}`} role="status" style="margin-bottom:var(--ws-gap)">
      {props.notice.text}
    </div>
  );
}
function Doctrine(props: { text: string }): VNode {
  return <div className="evi-advisory">{props.text}</div>;
}
function base(project: Project): string {
  return `/project/${project.id}/infrastructure-data`;
}
function Tabs(props: { project: Project; active: "overview" | "oc4ids" | "observations"; unverified: number }): VNode {
  const b = base(props.project);
  return (
    <WorkspaceTabs
      label="Infrastructure data domains"
      items={[
        { href: b, label: "Overview", active: props.active === "overview" },
        { href: `${b}/oc4ids`, label: "OC4IDS Export", active: props.active === "oc4ids" },
        { href: `${b}/observations`, label: "External Field Observations", active: props.active === "observations", count: props.unverified || undefined },
      ]}
    />
  );
}
function projectSub(project: Project, tail: string): string {
  return `${project.name} · ${project.pilot?.code ?? project.id.toUpperCase()} · ${tail}`;
}
function Providers(props: { providers: InteropProviderSpec[]; notice: string }): VNode {
  return (
    <DensePanel title="Provider boundaries">
      <div className="evi-detail-head" style="flex-wrap:wrap;gap:6px">
        {props.providers.map((p) => (
          <span className="chip dim" title={p.description}>{p.displayName} — not connected</span>
        ))}
      </div>
      <p className="sub" style="margin:8px 0 0">{props.notice}</p>
    </DensePanel>
  );
}
function SourceProvenancePanel(props: { excluded: string[] }): VNode {
  return (
    <DensePanel title="Source Provenance">
      <p className="sub" style="margin:0 0 8px">
        <b>OC4IDS</b> is standardized infrastructure disclosure, built only from authoritative OBV project records.
        <b> OBV</b> is verification, provenance, review and financial control. Kept out of every export:
      </p>
      <ul className="slist" style="margin:0">
        {props.excluded.map((x) => (
          <li><span className="srow"><span className="s-body"><span className="s-t">{x}</span></span></span></li>
        ))}
      </ul>
    </DensePanel>
  );
}

// ==================================================== overview

export function renderInteropWorkspace(input: {
  nav: NavContext;
  project: Project;
  preview: Oc4idsPreview;
  observations: ObservationListRow[];
  stats: Record<string, number>;
  providers: { providers: InteropProviderSpec[]; notice: string };
  canExport: boolean;
  canImport: boolean;
  canReview: boolean;
  notice?: InteropNotice | null;
  observationNotice: string;
}): string {
  const { project, preview } = input;
  const b = base(project);
  const unverified = input.stats.UNVERIFIED ?? 0;
  return renderDocument(
    <AppShell title="Infrastructure Data" nav={input.nav} context={`Infrastructure Data · ${project.name.slice(0, 40)}`}>
      <div className="page-wrap ws">
        <WorkHeader
          title="Infrastructure Data"
          sub={projectSub(project, "Infrastructure data standard and external field observations")}
          crumb={{ href: `/project/${project.id}`, label: project.name.slice(0, 40) }}
        >
          <a className="btn ghost sm" href={`${b}/oc4ids`}>{icons.file(13)} Preview OC4IDS</a>
          <a className="btn ghost sm" href={`${b}/observations`}>{icons.camera()} External observations</a>
          <a className="btn ghost sm hide-mobile" href={`/timeline/project/${project.id}`}>Timeline</a>
        </WorkHeader>
        <Notice notice={input.notice} />
        <Doctrine text={preview.notice} />
        <KpiRail
          items={[
            { label: "OC4IDS status", value: STATUS_LABEL[preview.status] ?? preview.status, tone: preview.status === "READY" ? "ok" : preview.status === "INVALID" ? "bad" : preview.status === "INCOMPLETE" ? "warn" : undefined, detail: `OC4IDS ${preview.schemaVersion} · mapping ${preview.mappingVersion}`, href: `${b}/oc4ids` },
            { label: "Last exported", value: preview.lastExport ? when(preview.lastExport.exportedAt).slice(0, 16) : "Never", detail: preview.lastExport ? `${preview.exportCount} export(s) on record` : "no export produced yet" },
            { label: "Field coverage", value: `${preview.coverage.populatedTopLevelFields.length} of ${preview.coverage.implementedTopLevelFields.length}`, detail: `${preview.fields.length} values populated · ${preview.omitted.length} omitted with reasons` },
            { label: "Unverified observations", value: String(unverified), tone: unverified > 0 ? "warn" : undefined, detail: unverified > 0 ? "awaiting reviewer decision" : "nothing awaiting review", href: `${b}/observations` },
            { label: "Accepted as evidence", value: String(input.stats.ACCEPTED ?? 0), detail: `${input.stats.REJECTED ?? 0} rejected · ${input.stats.DEFERRED ?? 0} deferred` },
          ]}
        />
        <Tabs project={project} active="overview" unverified={unverified} />
        <Workbench
          main={
            <>
              <DensePanel
                title="Infrastructure Data Standard — OC4IDS"
                right={chip(preview.status)}
                foot={
                  <span className="evi-actions" style="display:flex;gap:8px;flex-wrap:wrap">
                    <a className="btn ghost sm" href={`${b}/oc4ids`}>Preview OC4IDS</a>
                    {input.canExport && preview.canExport ? (
                      <form method="POST" action={`/api/interop/oc4ids/${project.id}/export`} style="margin:0">
                        <button className="btn sm" type="submit" data-busy-label="Exporting…">{icons.download(13)} Export JSON</button>
                      </form>
                    ) : null}
                    <a className="btn ghost sm" href={`/api/interop/oc4ids/${project.id}/validation-report`}>Download validation report</a>
                  </span>
                }
              >
                <DenseFacts
                  rows={[
                    { k: "Status", v: <>{chip(preview.status)}{preview.statusReasons.length ? <span className="sub" style="display:block;margin-top:4px">{preview.statusReasons.join(" ")}</span> : null}</> },
                    { k: "Schema version", v: `OC4IDS ${preview.schemaVersion} (package ${preview.packageVersion}) — implemented subset` },
                    { k: "Mapping version", v: preview.mappingVersion },
                    { k: "Publisher", v: `${preview.publisher.name}${preview.publisher.projectIdPrefix ? ` · prefix ${preview.publisher.projectIdPrefix}` : " · no registered prefix configured"}` },
                    { k: "Validation", v: preview.validation.valid && preview.packageValidation.valid ? `valid against the implemented schema subset · ${preview.validation.warnings.length + preview.packageValidation.warnings.length} warning(s)` : `${preview.validation.errors.length + preview.packageValidation.errors.length} validation error(s)` },
                    { k: "Last export", v: preview.lastExport ? <>{when(preview.lastExport.exportedAt)} · <TechnicalHash label="SHA-256" value={preview.lastExport.payloadSha256} /></> : "none" },
                  ]}
                />
              </DensePanel>
              <DensePanel
                title="External Field Observations"
                right={<a href={`${b}/observations`}>Review observations →</a>}
                flush
              >
                <ObservationTable rows={input.observations.slice(0, 8)} empty="No external observations have been imported for this project." />
              </DensePanel>
              <AboutView label="Methodology">
                <p>{preview.notice}</p>
                <p>{input.observationNotice}</p>
                <p>{preview.schemaCoverage.statement}</p>
              </AboutView>
            </>
          }
          rail={
            <>
              <SourceProvenancePanel excluded={preview.excludedObvIntelligence} />
              <Providers providers={input.providers.providers} notice={input.providers.notice} />
            </>
          }
        />
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

function ObservationTable(props: { rows: ObservationListRow[]; empty: string; showProject?: boolean }): VNode {
  const columns = [
    { key: "id", label: "External record" },
    { key: "provider", label: "Provider" },
    ...(props.showProject ? [{ key: "project", label: "Project" }] : []),
    { key: "observed", label: "Observed" },
    { key: "collector", label: "Collector" },
    { key: "coords", label: "Source coordinates" },
    { key: "photos", label: "Photos", num: true },
    { key: "match", label: "Project match" },
    { key: "status", label: "Status" },
  ];
  return (
    <DenseTable
      columns={columns}
      empty={props.empty}
      rows={props.rows.map((r) => {
        const o = r.observation;
        return {
          id: <a href={`/interop/field-observations/${o.id}`}>{o.externalObservationId}</a>,
          provider: r.providerName,
          project: r.projectName ?? <span className="sub">unassigned</span>,
          observed: when(o.observedAt),
          collector: o.collector ?? "—",
          coords: o.latitude !== null && o.longitude !== null ? `${o.latitude.toFixed(5)}, ${o.longitude.toFixed(5)}` : "none supplied",
          photos: `${r.photosTransferred} of ${o.photoCount}`,
          match: chip(o.matchVerdict),
          status: chip(o.status),
        };
      })}
    />
  );
}

// ==================================================== OC4IDS preview

export function renderOc4idsPreview(input: {
  nav: NavContext;
  project: Project;
  preview: Oc4idsPreview;
  exports: InteropExportRecord[];
  users: Map<string, { name: string }>;
  canExport: boolean;
  unverified: number;
  notice?: InteropNotice | null;
}): string {
  const { project, preview } = input;
  const b = base(project);
  const json = JSON.stringify(preview.package, null, 2);
  const truncated = json.length > 20_000;
  const reasonTone: Record<string, string> = {
    NOT_CONFIGURED: "warn", NO_AUTHORITATIVE_SOURCE: "neutral", VALUE_ABSENT: "neutral", NOT_REPRESENTABLE: "neutral", OBV_INTELLIGENCE_EXCLUDED: "info",
  };
  const reasonLabel: Record<string, string> = {
    NOT_CONFIGURED: "Not configured", NO_AUTHORITATIVE_SOURCE: "No authoritative OBV source", VALUE_ABSENT: "Value absent in OBV",
    NOT_REPRESENTABLE: "Not representable", OBV_INTELLIGENCE_EXCLUDED: "OBV intelligence — excluded by design",
  };
  return renderDocument(
    <AppShell title="OC4IDS Export" nav={input.nav} context={`OC4IDS Export · ${project.name.slice(0, 40)}`}>
      <div className="page-wrap ws">
        <WorkHeader
          title="OC4IDS Export"
          sub={projectSub(project, `Infrastructure Data Standard · OC4IDS ${preview.schemaVersion} (implemented subset) · mapping ${preview.mappingVersion}`)}
          crumb={{ href: b, label: "Infrastructure Data" }}
        >
          <a className="btn ghost sm" href={`/api/interop/oc4ids/${project.id}/preview`}>{icons.file(13)} Preview JSON</a>
          <a className="btn ghost sm" href={`/api/interop/oc4ids/${project.id}/validation-report`}>Download validation report</a>
          {input.canExport && preview.canExport ? (
            <form method="POST" action={`/api/interop/oc4ids/${project.id}/export`} style="display:inline">
              <button className="btn sm" type="submit" data-busy-label="Exporting…">{icons.download(13)} Export JSON</button>
            </form>
          ) : null}
        </WorkHeader>
        <Notice notice={input.notice} />
        <Doctrine text={preview.notice} />
        <KpiRail
          items={[
            { label: "Status", value: STATUS_LABEL[preview.status] ?? preview.status, tone: preview.status === "READY" ? "ok" : preview.status === "INVALID" ? "bad" : preview.status === "INCOMPLETE" ? "warn" : undefined, detail: preview.statusReasons[0] ?? "validates against the implemented schema subset" },
            { label: "Populated values", value: String(preview.fields.length), detail: `${preview.coverage.populatedTopLevelFields.length} of ${preview.coverage.implementedTopLevelFields.length} top-level fields` },
            { label: "Omitted fields", value: String(preview.omitted.length), detail: "each with a stated reason — nothing inferred" },
            { label: "Validation", value: preview.validation.valid && preview.packageValidation.valid ? "Valid" : "Errors", tone: preview.validation.valid && preview.packageValidation.valid ? "ok" : "bad", detail: `${preview.validation.errors.length + preview.packageValidation.errors.length} error(s) · ${preview.validation.warnings.length + preview.packageValidation.warnings.length} warning(s)` },
            { label: "Exports on record", value: String(input.exports.length), detail: preview.lastExport ? `last ${when(preview.lastExport.exportedAt)}` : "none yet" },
          ]}
        />
        <Tabs project={project} active="oc4ids" unverified={input.unverified} />
        {preview.statusReasons.length ? (
          <div className={`attn ${preview.status === "INVALID" ? "bad" : "info"}`} role="status" style="margin-bottom:var(--ws-gap)">
            {preview.statusReasons.join(" ")}
          </div>
        ) : null}
        <Workbench
          main={
            <>
              <DensePanel title="Populated fields — every value with its OBV source" flush>
                <DenseTable
                  columns={[
                    { key: "path", label: "OC4IDS field" },
                    { key: "value", label: "Value" },
                    { key: "source", label: "OBV source record" },
                  ]}
                  empty="No field could be populated from authoritative OBV data."
                  rows={preview.fields.map((f) => ({
                    path: <code>{f.path}</code>,
                    value: <span style="overflow-wrap:anywhere">{formatValue(f.value)}</span>,
                    source: <span className="sub"><code>{f.source.table}.{f.source.field}</code> · {f.source.recordId}{f.source.note ? ` — ${f.source.note}` : ""}</span>,
                  }))}
                />
              </DensePanel>
              <DensePanel title="Omitted fields — stated reasons, never inferred" flush>
                <DenseTable
                  columns={[
                    { key: "path", label: "OC4IDS field" },
                    { key: "reason", label: "Reason" },
                    { key: "detail", label: "Detail" },
                  ]}
                  empty="Nothing omitted."
                  rows={preview.omitted.map((o) => ({
                    path: <code>{o.path}</code>,
                    reason: <span className={`chip ${reasonTone[o.reason] ?? "neutral"}`}>{reasonLabel[o.reason] ?? enumLabel(o.reason)}</span>,
                    detail: <span className="sub">{o.detail}</span>,
                  }))}
                />
              </DensePanel>
              <DensePanel title="Validation">
                <p className="sub" style="margin:0 0 8px">{preview.schemaCoverage.statement}</p>
                {preview.validation.errors.length + preview.packageValidation.errors.length === 0 ? (
                  <p style="margin:0"><span className="chip ok">Valid</span> No schema violations in the project object or the package envelope.</p>
                ) : (
                  <ul className="slist">
                    {[...preview.validation.errors, ...preview.packageValidation.errors].map((e) => (
                      <li><span className="srow"><span className="s-ico high">{icons.alert(12)}</span><span className="s-body"><span className="s-t"><code>{e.path}</code> · {e.keyword}</span><span className="s-s">{e.message}</span></span></span></li>
                    ))}
                  </ul>
                )}
                {preview.validation.warnings.length + preview.packageValidation.warnings.length > 0 ? (
                  <ul className="slist" style="margin-top:8px">
                    {[...preview.validation.warnings, ...preview.packageValidation.warnings].map((w) => (
                      <li><span className="srow"><span className="s-ico low">{icons.alert(12)}</span><span className="s-body"><span className="s-t"><code>{w.path}</code> · {w.codelist}</span><span className="s-s">{w.message}</span></span></span></li>
                    ))}
                  </ul>
                ) : null}
              </DensePanel>
              <DensePanel title="Package preview (JSON)">
                <p className="sub" style="margin:0 0 8px">Preview packages carry a fixed placeholder publication date so two previews of unchanged records are byte-identical; a produced export stamps its real publication time and its retrieval URL.</p>
                <pre className="evi-pre">{truncated ? json.slice(0, 20_000) : json}</pre>
                {truncated ? <p className="sub">Preview truncated at 20,000 characters — the JSON API returns the whole package.</p> : null}
              </DensePanel>
            </>
          }
          rail={
            <>
              <DensePanel title="Export">
                <DenseFacts
                  rows={[
                    { k: "Publisher", v: preview.publisher.name },
                    { k: "Registered prefix", v: preview.publisher.projectIdPrefix ?? <span className="warn-t">not configured</span> },
                    { k: "License", v: preview.publisher.licenseUrl ?? "not stated" },
                    { k: "Publication policy", v: preview.publisher.publicationPolicyUrl ?? "not stated" },
                    { k: "Source records", v: `${preview.sourceRecords.length} authoritative record(s)` },
                  ]}
                />
                {input.canExport && preview.canExport ? (
                  <form method="POST" action={`/api/interop/oc4ids/${project.id}/export`} style="margin-top:10px">
                    <button className="btn sm" type="submit" data-busy-label="Exporting…">{icons.download(13)} Export JSON</button>
                  </form>
                ) : (
                  <p className="sub" style="margin:10px 0 0">
                    {!input.canExport ? "Producing an export requires an administrator or funder representative." : "Export is unavailable until the status above is Ready or Incomplete."}
                  </p>
                )}
              </DensePanel>
              <DensePanel title="Export history" flush>
                <DenseTable
                  columns={[
                    { key: "at", label: "Exported" },
                    { key: "by", label: "By" },
                    { key: "hash", label: "SHA-256" },
                    { key: "dl", label: "" },
                  ]}
                  empty="No export has been produced."
                  rows={input.exports.map((e) => ({
                    at: when(e.exportedAt),
                    by: input.users.get(e.exportedByUserId)?.name ?? e.exportedByUserId,
                    hash: <code title={e.payloadSha256}>{e.payloadSha256.slice(0, 12)}…</code>,
                    dl: <a className="btn ghost sm" href={`/api/interop/oc4ids/exports/${e.id}`}>{icons.download(12)} JSON</a>,
                  }))}
                />
              </DensePanel>
              <SourceProvenancePanel excluded={preview.excludedObvIntelligence} />
              <DensePanel title="Schema coverage">
                <DenseFacts
                  rows={[
                    { k: "Standard", v: `OC4IDS ${preview.schemaVersion} · package version ${preview.packageVersion}` },
                    { k: "Implemented fields", v: `${preview.schemaCoverage.implementedProjectFields.length} project fields · ${preview.schemaCoverage.implementedDefinitions.length} definitions` },
                    { k: "Validator keywords", v: preview.schemaCoverage.validatorKeywords.join(", ") },
                    { k: "Not implemented", v: preview.schemaCoverage.notImplemented.join("; ") },
                  ]}
                />
              </DensePanel>
            </>
          }
        />
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

// ==================================================== observations list

export function renderObservationList(input: {
  nav: NavContext;
  project: Project;
  rows: ObservationListRow[];
  stats: Record<string, number>;
  imports: FieldObservationImport[];
  providers: { providers: InteropProviderSpec[]; notice: string };
  formats: { envelope: string; version: string; kobo: string; limits: Record<string, number> };
  canImport: boolean;
  canReview: boolean;
  notice?: InteropNotice | null;
  doctrine: string;
}): string {
  const { project } = input;
  const b = base(project);
  const unverified = input.stats.UNVERIFIED ?? 0;
  return renderDocument(
    <AppShell title="External Field Observations" nav={input.nav} context={`External Field Observations · ${project.name.slice(0, 40)}`}>
      <div className="page-wrap ws">
        <WorkHeader
          title="External Field Observations"
          sub={projectSub(project, "Imported field data stays unverified until a reviewer decides")}
          crumb={{ href: b, label: "Infrastructure Data" }}
        >
          <a className="btn ghost sm hide-mobile" href={`/timeline/twin/${project.id}`}>{icons.map(13)} Site Evidence</a>
        </WorkHeader>
        <Notice notice={input.notice} />
        <Doctrine text={input.doctrine} />
        <KpiRail
          items={[
            { label: "Unverified", value: String(unverified), tone: unverified > 0 ? "warn" : undefined, detail: "awaiting a reviewer decision" },
            { label: "Accepted as evidence", value: String(input.stats.ACCEPTED ?? 0), detail: "entered the governed evidence pipeline" },
            { label: "Rejected", value: String(input.stats.REJECTED ?? 0) },
            { label: "Deferred", value: String(input.stats.DEFERRED ?? 0) },
            { label: "Imports", value: String(input.imports.length), detail: "immutable source snapshots" },
          ]}
        />
        <Tabs project={project} active="observations" unverified={unverified} />
        <Workbench
          main={
            <>
              <DensePanel title="Observations" flush>
                <ObservationTable rows={input.rows} empty="No external observations are matched to this project." />
              </DensePanel>
              <DensePanel title="Import snapshots" flush>
                <DenseTable
                  columns={[
                    { key: "at", label: "Imported" },
                    { key: "provider", label: "Provider" },
                    { key: "count", label: "Observations", num: true },
                    { key: "dups", label: "Duplicates skipped", num: true },
                    { key: "hash", label: "Snapshot SHA-256" },
                  ]}
                  empty="No imports yet."
                  rows={input.imports.map((i) => ({
                    at: when(i.importedAt),
                    provider: i.providerLabel ?? enumLabel(i.sourceSystem),
                    count: String(i.observationCount),
                    dups: String(i.duplicateCount),
                    hash: <code title={i.payloadSha256}>{i.payloadSha256.slice(0, 12)}…</code>,
                  }))}
                />
              </DensePanel>
            </>
          }
          rail={
            <>
              {input.canImport ? (
                <DensePanel title="Import observations">
                  <form method="POST" action="/api/interop/field-observations/import" className="fo-form">
                    <input type="hidden" name="projectId" value={project.id} />
                    <label className="sub" style="display:block;margin-bottom:4px">Import payload (JSON — the OBV field-observation format or a KoBoToolbox-style submissions export)</label>
                    <textarea name="payload" rows="8" required style="width:100%;box-sizing:border-box;font:12px var(--mono);"></textarea>
                    <label className="sub" style="display:block;margin:8px 0 4px">Notes (optional)</label>
                    <input type="text" name="notes" maxlength="400" style="width:100%;box-sizing:border-box" />
                    <button className="btn sm" type="submit" style="margin-top:10px" data-busy-label="Importing…">Import as unverified observations</button>
                  </form>
                  <p className="sub" style="margin:8px 0 0">
                    Every import is stored as an immutable snapshot. Observations arrive as <b>External observation — unverified</b> and become evidence only when a reviewer accepts them.
                  </p>
                </DensePanel>
              ) : null}
              <DensePanel title="Accepted formats">
                <DenseFacts
                  rows={[
                    { k: "OBV format", v: `${input.formats.envelope} v${input.formats.version}` },
                    { k: "KoBoToolbox / ODK", v: `${input.formats.kobo} (translated deterministically; attachments recorded as URLs, never retrieved)` },
                    { k: "Limits", v: `${input.formats.limits.maxObservations} observations · ${input.formats.limits.maxPhotosPerObservation} photos each · ${Math.round(input.formats.limits.maxPhotoBytes / 1024 / 1024)} MB per photo` },
                    { k: "Photo types", v: "JPEG, PNG, WebP — verified by content, not by the declared type" },
                  ]}
                />
              </DensePanel>
              <Providers providers={input.providers.providers} notice={input.providers.notice} />
            </>
          }
        />
      </div>
    </AppShell>
  );
}

// ==================================================== observation detail

export function renderObservationDetail(input: {
  nav: NavContext;
  detail: ObservationDetail;
  assignableProjects: Project[];
  users: Map<string, { name: string }>;
  canReview: boolean;
  /** Importers and reviewers may assign a project (a matching step, not a
   *  verification decision). */
  canAssign: boolean;
  notice?: InteropNotice | null;
}): string {
  const d = input.detail;
  const o = d.observation;
  const crumb = d.project
    ? { href: `${base(d.project)}/observations`, label: "External Field Observations" }
    : { href: "/projects", label: "Projects" };
  const actionable = o.status === "UNVERIFIED" || o.status === "DEFERRED";
  const formFieldRows = Object.entries(o.formFields ?? {}).map(([k, v]) => ({ k, v: formatValue(v) }));
  const needsProject = !d.project || o.matchVerdict === "AMBIGUOUS" || o.matchVerdict === "NO_MATCH";
  const assignForm = input.canAssign && actionable && needsProject ? (
    <form method="POST" action={`/api/interop/field-observations/${o.id}/assign`} style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end">
      <label className="sub">Assign project
        <select name="projectId" required style="display:block">
          {input.assignableProjects.map((p) => <option value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <input type="text" name="note" placeholder="Note (optional)" maxlength="400" />
      <button className="btn secondary sm" type="submit">Assign</button>
    </form>
  ) : null;
  return renderDocument(
    <AppShell title="External observation" nav={input.nav} context={d.project ? `External observation · ${d.project.name.slice(0, 40)}` : "External observation"}>
      <div className="page-wrap ws">
        <WorkHeader
          title={`External observation ${o.externalObservationId}`}
          sub={`${d.providerName} · ${o.observedAt ? `observed ${when(o.observedAt)}` : "no source timestamp"} · imported ${when(o.ingestedAt)}`}
          crumb={crumb}
        >
          <span className="evi-detail-head">{chip(o.status)}{chip(o.matchVerdict)}</span>
        </WorkHeader>
        <Notice notice={input.notice} />
        <Doctrine text={d.notice} />
        <div className="evi-split">
          <section className="evi-card">
            <h2>External observation (imported — unverified)</h2>
            <table className="evi-table">
              <tbody>
                <tr><td>Source</td><td>External Field Observation · Provider: {d.providerName}</td></tr>
                <tr><td>External record</td><td><code>{o.externalObservationId}</code></td></tr>
                <tr><td>Collector</td><td>{o.collector ?? "not supplied"}</td></tr>
                <tr><td>Observed (source)</td><td>{o.observedAt ? `${when(o.observedAt)}${o.observedAtVerbatim && o.observedAtVerbatim !== o.observedAt ? ` (verbatim "${o.observedAtVerbatim}")` : ""}` : o.observedAtVerbatim ? `unparseable verbatim "${o.observedAtVerbatim}"` : "not supplied"}</td></tr>
                <tr><td>Source coordinates</td><td>{o.latitude !== null && o.longitude !== null ? `${o.latitude.toFixed(6)}, ${o.longitude.toFixed(6)}${o.accuracyMeters !== null ? ` · accuracy ±${o.accuracyMeters} m` : " · accuracy not supplied"}` : "none supplied"}</td></tr>
                <tr><td>Project reference</td><td>{o.projectReference ?? "none"}</td></tr>
                <tr><td>Milestone reference</td><td>{o.milestoneReference ?? "none"}</td></tr>
                <tr><td>Comments</td><td>{o.comments ?? "—"}</td></tr>
                <tr><td>Source record hash</td><td><code>{o.sourceRecordSha256.slice(0, 24)}…</code></td></tr>
                <tr><td>Import snapshot</td><td>{d.import ? <>{when(d.import.importedAt)} · <code>{d.import.payloadSha256.slice(0, 16)}…</code> · {input.users.get(d.import.importedByUserId)?.name ?? d.import.importedByUserId}</> : "—"}</td></tr>
              </tbody>
            </table>
            {formFieldRows.length ? (
              <>
                <h2 style="margin-top:12px">Form fields (verbatim)</h2>
                <table className="evi-table"><tbody>{formFieldRows.map((r) => <tr><td>{r.k}</td><td>{r.v}</td></tr>)}</tbody></table>
              </>
            ) : null}
            <h2 style="margin-top:12px">Photos</h2>
            {d.photos.length === 0 ? <p className="sub">No photos were supplied.</p> : null}
            {d.photos.map((p) => (
              <div style="margin-bottom:10px">
                {p.url ? <img className="evi-photo" src={p.url} alt={p.fileName ?? "observation photo"} /> : null}
                <p className="sub" style="margin:4px 0 0">
                  {p.fileName ?? `photo ${p.seq + 1}`} · {p.contentType ?? "type unknown"} · {p.transferred ? `${p.bytes} bytes · sha256 ${p.sha256?.slice(0, 16)}…` : "not transferred — source URL recorded, never retrieved by OBV"}
                  {p.sourceUrl ? <><br /><span style="overflow-wrap:anywhere">source URL: {p.sourceUrl}</span></> : null}
                  {p.caption ? <><br />{p.caption}</> : null}
                </p>
              </div>
            ))}
          </section>
          <section className="evi-card">
            <h2>OBV project record (authoritative)</h2>
            {d.project ? (
              <table className="evi-table">
                <tbody>
                  <tr><td>Project</td><td><a href={`/project/${d.project.id}`}>{d.project.name}</a></td></tr>
                  <tr><td>Code</td><td>{d.project.pilot?.code ?? d.project.id}</td></tr>
                  <tr><td>Status</td><td>{enumLabel(d.project.status)}</td></tr>
                  <tr><td>Site boundary check</td><td>{d.geofence.detail}</td></tr>
                  <tr><td>Milestones</td><td>{d.milestones.length ? d.milestones.map((m) => `${m.seq} · ${m.title}`).join("; ") : "none"}</td></tr>
                </tbody>
              </table>
            ) : (
              <p className="sub">No project is assigned. {input.canAssign ? "Assign one below before any further review." : "The importer or a reviewer must assign a project before it can be reviewed."}</p>
            )}
            <h2 style="margin-top:12px">Project matching</h2>
            <p style="margin:0 0 6px">{chip(o.matchVerdict)}</p>
            <ul className="slist">
              {o.matchReasons.map((r) => (
                <li><span className="srow"><span className="s-body"><span className="s-t">{r}</span></span></span></li>
              ))}
            </ul>
            {d.acceptedEvidence ? (
              <>
                <h2 style="margin-top:12px">Resulting evidence</h2>
                <p className="sub" style="margin:0">
                  Evidence <code>{d.acceptedEvidence.id}</code> on {d.acceptedEvidence.milestoneTitle ?? "its milestone"} · pipeline verdict {d.acceptedEvidence.verdict ?? "pending"}.{" "}
                  {d.project ? <a href={`/timeline/twin/${d.project.id}?pin=${encodeURIComponent(d.acceptedEvidence.id)}`}>Open in Site Evidence →</a> : null}{" "}
                  <a href={`/evidence-intelligence/evidence/${d.acceptedEvidence.id}`}>Evidence Intelligence →</a>
                </p>
              </>
            ) : null}
          </section>
        </div>

        {input.canReview && actionable ? (
          <section className="evi-card">
            <h2>Reviewer decision</h2>
            {d.acceptance.possible ? (
              <p className="sub" style="margin:0 0 8px">
                Accepting sends this observation through the same governed evidence pipeline as direct capture; the pipeline issues its own verdict and nothing is approved or released by this decision. You will be recorded as the submitter of the resulting evidence and therefore cannot approve its milestone.
              </p>
            ) : (
              <p className="sub" style="margin:0 0 8px">Cannot accept yet: {d.acceptance.blockers.join("; ")}.</p>
            )}
            <div className="evi-actions" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
              {d.acceptance.possible ? (
                <form method="POST" action={`/api/interop/field-observations/${o.id}/accept`} style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end">
                  <label className="sub">Milestone
                    <select name="milestoneId" required style="display:block">
                      {d.milestones.map((m) => (
                        <option value={m.id} selected={o.suggestedMilestoneId === m.id}>{m.seq} · {m.title}</option>
                      ))}
                    </select>
                  </label>
                  {d.photos.filter((p) => p.transferred).length > 1 ? (
                    <label className="sub">Photo
                      <select name="photoId" style="display:block">
                        {d.photos.filter((p) => p.transferred).map((p) => <option value={p.id}>{p.fileName ?? `photo ${p.seq + 1}`}</option>)}
                      </select>
                    </label>
                  ) : null}
                  <input type="text" name="note" placeholder="Note (optional)" maxlength="400" />
                  <button className="btn sm" type="submit">Accept as evidence</button>
                </form>
              ) : null}
              {assignForm}
              <form method="POST" action={`/api/interop/field-observations/${o.id}/reject`} style="display:flex;gap:6px;align-items:flex-end">
                <input type="text" name="note" placeholder="Reason (optional)" maxlength="400" />
                <button className="btn ghost sm" type="submit">Reject</button>
              </form>
              {o.status !== "DEFERRED" ? (
                <form method="POST" action={`/api/interop/field-observations/${o.id}/defer`} style="display:flex;gap:6px;align-items:flex-end">
                  <input type="text" name="note" placeholder="Note (optional)" maxlength="400" />
                  <button className="btn ghost sm" type="submit">Defer</button>
                </form>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="evi-card">
            <h2>{actionable ? "Review" : "Resolution"}</h2>
            <p className="sub" style="margin:0">
              {actionable
                ? "This observation awaits a reviewer decision (funder representative or compliance reviewer)."
                : `${STATUS_LABEL[o.status] ?? o.status} by ${o.reviewedByUserId ? input.users.get(o.reviewedByUserId)?.name ?? o.reviewedByUserId : "—"} at ${when(o.reviewedAt)}${o.reviewNote ? ` — ${o.reviewNote}` : ""}.`}
            </p>
            {assignForm ? <div style="margin-top:8px">{assignForm}</div> : null}
          </section>
        )}

        <section className="evi-card">
          <h2>History</h2>
          <ol className="evi-timeline">
            {d.events.map((e) => (
              <li className="evi-tl-item">
                <span className="sub">{when(e.occurredAt)}</span>
                <div className="evi-tl-body">
                  <b>{enumLabel(e.kind)}</b>
                  {e.actorUserId ? ` · ${input.users.get(e.actorUserId)?.name ?? e.actorUserId}` : ""}
                  {e.detail ? <span className="sub" style="display:block">{e.detail}</span> : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </AppShell>
  );
}
