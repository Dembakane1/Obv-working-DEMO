/**
 * OBV spatial map — a compact, zero-dependency Web-Mercator slippy map.
 *
 * Why not a mapping library: this build environment has no npm registry
 * access, so the engine is ~300 lines of tile math behind a provider
 * adapter. Tiles come from token-free public services (standard map:
 * OpenStreetMap; satellite: Esri World Imagery) — there is no map key or
 * secret anywhere, client or server.
 *
 * The map is a PRESENTATION layer: every status shown here is read from
 * /api/map-context, which reads the primary verification/governance
 * records. The map computes nothing and can change nothing.
 */

interface MapSegment {
  evidenceCount: number;
  latestVerdict: string | null;
  id: string;
  milestoneId: string;
  seq: number;
  title: string;
  requirement: string;
  label: string;
  geometry: Array<[number, number]>;
  status: string;
  accountStatus: string;
  trancheAmount: number;
  approvalStatus: string | null;
  approvalsRecorded: number;
  approvalsRequired: number;
  threadId: string | null;
}

interface MapEvidence {
  id: string;
  milestoneId: string;
  seq: number;
  milestoneTitle: string;
  latitude: number;
  longitude: number;
  capturedAt: string;
  uploadedAt: string;
  capturedBy: string;
  photoPath: string;
  isDemoFallback: boolean;
  verdict: string | null;
  confidence: number | null;
  source: string | null;
  geofencePassed: boolean | null;
  insideBoundary: boolean;
  approvalStatus: string | null;
  accountStatus: string;
  ledgerSeq: number | null;
  threadId: string | null;
}

interface MapProject {
  id: string;
  name: string;
  location: string;
  boundary: Array<[number, number]>;
  route: { label: string; geometry: Array<[number, number]> } | null;
  totalBudget: number;
  released: number;
  held: number;
  milestoneCount: number;
  pendingApprovals: number;
  chainValid: boolean;
  segments: MapSegment[];
  evidence: MapEvidence[];
}

(() => {
  const wrap = document.getElementById("map-wrap");
  const canvas = document.getElementById("map-canvas");
  if (!wrap || !canvas) return;

  // ---------------- tile provider adapter (token-free public sources) ---
  const LAYERS: Record<string, { url: (z: number, x: number, y: number) => string; attribution: string; maxZoom: number }> = {
    map: {
      url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
      attribution: "© OpenStreetMap contributors",
      maxZoom: 19,
    },
    satellite: {
      url: (z, x, y) =>
        `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
      maxZoom: 18,
    },
  };
  let activeLayer: "map" | "satellite" = "map";

  // Status palette (mirrors the app's semantic tokens; `review` is a
  // muted orange kept visually distinct from the governance amber).
  const TONE: Record<string, string> = {
    ok: "#196138",
    info: "#1d3fad",
    warn: "#955104",
    review: "#c05621",
    bad: "#a92c21",
    neutral: "#6a7280",
  };

  // Corridor state colors come from the ACTUAL product state model:
  // milestone.status already encodes evidence -> verification ->
  // governance -> financial progression (RELEASED is set only by the
  // completed two-role approval releasing the tranche). A VERIFIED
  // milestone with funds HELD shows as AWAITING GOVERNANCE, never green.
  function segmentTone(status: string): string {
    switch (status) {
      case "RELEASED":
      case "APPROVED": return TONE.ok;
      case "VERIFIED": return TONE.warn; // verified, funds HELD — awaiting governance
      case "UNDER_REVIEW": return TONE.review;
      case "PENDING_EVIDENCE": return TONE.info;
      default: return TONE.neutral;
    }
  }
  function segmentStateLabel(status: string): string {
    switch (status) {
      case "RELEASED": return "RELEASED";
      case "APPROVED": return "APPROVED — RELEASE PENDING";
      case "VERIFIED": return "AWAITING GOVERNANCE";
      case "UNDER_REVIEW": return "NEEDS REVIEW";
      case "PENDING_EVIDENCE": return "AWAITING EVIDENCE";
      default: return "NOT STARTED";
    }
  }
  function evidenceTone(e: MapEvidence): string {
    if (e.verdict === "REJECTED" || e.insideBoundary === false) return TONE.bad;
    if (e.verdict === "NEEDS_REVIEW" || e.geofencePassed === false) return TONE.review;
    if (e.verdict === "VERIFIED") return TONE.ok;
    return TONE.neutral;
  }
  function evidenceStateLabel(e: MapEvidence): string {
    if (e.insideBoundary === false) return "OUTSIDE GEOFENCE";
    if (!e.verdict) return "UNVERIFIED";
    return e.verdict.replace(/_/g, " ");
  }

  // ---------------- Web-Mercator math ----------------
  const TILE = 256;
  const worldPx = (lng: number, lat: number, z: number): { x: number; y: number } => {
    const scale = TILE * Math.pow(2, z);
    const x = ((lng + 180) / 360) * scale;
    const rad = (lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale;
    return { x, y };
  };

  // ---------------- view state ----------------
  let center = { lng: 33.6, lat: -11.855 };
  let zoom = 12;
  const MIN_ZOOM = 3;

  const stage = canvas as HTMLElement;
  const tileLayer = document.createElement("div");
  tileLayer.className = "tiles";
  stage.appendChild(tileLayer);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "overlay");
  stage.appendChild(svg);
  const attribution = document.createElement("div");
  attribution.className = "map-attr";
  stage.appendChild(attribution);
  const zoomCtl = document.createElement("div");
  zoomCtl.className = "map-zoom";
  zoomCtl.innerHTML =
    '<button type="button" aria-label="Zoom in" data-z="1">+</button><button type="button" aria-label="Zoom out" data-z="-1">−</button>';
  stage.appendChild(zoomCtl);

  const toScreen = (lng: number, lat: number): { x: number; y: number } => {
    const c = worldPx(center.lng, center.lat, zoom);
    const p = worldPx(lng, lat, zoom);
    return { x: p.x - c.x + stage.clientWidth / 2, y: p.y - c.y + stage.clientHeight / 2 };
  };

  const tiles = new Map<string, HTMLImageElement>();

  // Degraded-base-map notice: if no tile of the active layer has loaded
  // and several have failed, geometry stays fully usable and we say so
  // honestly (no raw tile errors are ever surfaced).
  let tilesLoaded = 0;
  let tilesFailed = 0;
  const mapNote = document.getElementById("map-note");
  function tileOutcome(ok: boolean): void {
    if (ok) tilesLoaded++;
    else tilesFailed++;
    if (mapNote) mapNote.hidden = !(tilesLoaded === 0 && tilesFailed >= 3);
  }

  function renderTiles(): void {
    const layer = LAYERS[activeLayer];
    const c = worldPx(center.lng, center.lat, zoom);
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const x0 = Math.floor((c.x - w / 2) / TILE);
    const x1 = Math.floor((c.x + w / 2) / TILE);
    const y0 = Math.floor((c.y - h / 2) / TILE);
    const y1 = Math.floor((c.y + h / 2) / TILE);
    const wanted = new Set<string>();
    const worldTiles = Math.pow(2, zoom);
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = Math.max(0, y0); ty <= Math.min(worldTiles - 1, y1); ty++) {
        const wx = ((tx % worldTiles) + worldTiles) % worldTiles; // wrap lng
        const key = `${activeLayer}/${zoom}/${tx}/${ty}`;
        wanted.add(key);
        let img = tiles.get(key);
        if (!img) {
          img = document.createElement("img");
          img.className = "tile";
          img.alt = "";
          img.decoding = "async";
          img.loading = "lazy";
          // A tile that fails (offline demo) stays as the neutral base —
          // geometry and markers remain fully usable.
          img.addEventListener("error", () => {
            img!.classList.add("failed");
            tileOutcome(false);
          });
          img.addEventListener("load", () => tileOutcome(true));
          img.src = layer.url(zoom, wx, ty);
          tiles.set(key, img);
          tileLayer.appendChild(img);
        }
        img.style.left = `${tx * TILE - c.x + w / 2}px`;
        img.style.top = `${ty * TILE - c.y + h / 2}px`;
      }
    }
    for (const [key, img] of tiles) {
      if (!wanted.has(key)) {
        img.remove();
        tiles.delete(key);
      }
    }
    attribution.textContent = layer.attribution;
  }

  // ---------------- data + overlay ----------------
  let project: MapProject | null = null;
  let selected: { kind: "project" | "segment" | "evidence"; id?: string } | null = null;
  const filters = { time: "all", milestone: "all", verdict: "all" };

  function filteredEvidence(): MapEvidence[] {
    if (!project) return [];
    const now = Date.now();
    return project.evidence.filter((e) => {
      if (filters.time !== "all") {
        const days = Number(filters.time);
        if (now - Date.parse(e.uploadedAt) > days * 86400_000) return false;
      }
      if (filters.milestone !== "all" && e.milestoneId !== filters.milestone) return false;
      if (filters.verdict !== "all" && e.verdict !== filters.verdict) return false;
      return true;
    });
  }

  const svgNS = "http://www.w3.org/2000/svg";
  function poly(points: Array<[number, number]>, closed: boolean): string {
    return points
      .map((p, i) => {
        const s = toScreen(p[0], p[1]);
        return `${i === 0 ? "M" : "L"}${s.x.toFixed(1)},${s.y.toFixed(1)}`;
      })
      .join(" ") + (closed ? " Z" : "");
  }

  function el(name: string, attrs: Record<string, string>): SVGElement {
    const node = document.createElementNS(svgNS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  function renderOverlay(): void {
    svg.setAttribute("width", String(stage.clientWidth));
    svg.setAttribute("height", String(stage.clientHeight));
    svg.innerHTML = "";
    if (!project) return;

    // Site boundary (registered geofence) — dashed, never filled heavily.
    svg.appendChild(
      el("path", {
        d: poly(project.boundary, true),
        class: "geo-boundary",
      })
    );

    // Route base line under the segments.
    if (project.route) {
      svg.appendChild(el("path", { d: poly(project.route.geometry, false), class: "geo-route" }));
    }

    // Milestone segments, colored by current milestone state. Each
    // colored line sits on a light casing so the corridor stays readable
    // over dark satellite imagery, pale roads and vegetation alike.
    for (const seg of project.segments) {
      const isSel = selected?.kind === "segment" && selected.id === seg.id;
      const d = poly(seg.geometry, false);
      svg.appendChild(el("path", { d, class: `geo-casing${isSel ? " selected" : ""}` }));
      svg.appendChild(
        el("path", { d, class: `geo-segment${isSel ? " selected" : ""}`, stroke: segmentTone(seg.status) })
      );
      const hit = el("path", { d, class: "geo-hit" });
      hit.setAttribute("tabindex", "0");
      hit.setAttribute("role", "button");
      hit.setAttribute(
        "aria-label",
        `Milestone ${seg.seq}, ${seg.label}: ${segmentStateLabel(seg.status)}`
      );
      const pick = () => select({ kind: "segment", id: seg.id });
      hit.addEventListener("click", pick);
      hit.addEventListener("keydown", (ev) => {
        if ((ev as KeyboardEvent).key === "Enter" || (ev as KeyboardEvent).key === " ") {
          ev.preventDefault();
          pick();
        }
      });
      svg.appendChild(hit);
      // Mid-segment km label.
      const mid = seg.geometry[Math.floor(seg.geometry.length / 2)];
      const sPt = toScreen(mid[0], mid[1]);
      const label = el("text", { x: String(sPt.x), y: String(sPt.y - 10), class: "geo-label" });
      label.textContent = seg.label;
      svg.appendChild(label);
    }

    // Evidence markers: semantic center color + white outline; demo
    // fallback keeps its inner white dot; selection adds a controlled
    // blue outer ring. Keyboard-accessible on desktop.
    for (const e of filteredEvidence()) {
      const sPt = toScreen(e.longitude, e.latitude);
      const isSel = selected?.kind === "evidence" && selected.id === e.id;
      const g = el("g", { class: "geo-marker", transform: `translate(${sPt.x},${sPt.y})` });
      g.setAttribute("tabindex", "0");
      g.setAttribute("role", "button");
      g.setAttribute(
        "aria-label",
        `M${e.seq} evidence: ${evidenceStateLabel(e)}${e.isDemoFallback ? ", demo fallback" : ""}`
      );
      if (isSel) g.appendChild(el("circle", { r: "13", class: "geo-sel-ring" }));
      if (e.insideBoundary === false || e.geofencePassed === false) {
        g.appendChild(el("circle", { r: "15", class: "geo-warn-ring" }));
      }
      g.appendChild(el("circle", { r: "8", fill: evidenceTone(e), class: "dot" }));
      if (e.isDemoFallback) g.appendChild(el("circle", { r: "3", class: "geo-demo-dot" }));
      const pick = () => select({ kind: "evidence", id: e.id });
      g.addEventListener("click", pick);
      g.addEventListener("keydown", (ev) => {
        if ((ev as KeyboardEvent).key === "Enter" || (ev as KeyboardEvent).key === " ") {
          ev.preventDefault();
          pick();
        }
      });
      svg.appendChild(g);
    }
  }

  function render(): void {
    renderTiles();
    renderOverlay();
  }

  // ---------------- selection panel ----------------
  const panelBody = document.getElementById("map-panel-body")!;
  const panelEmpty = document.getElementById("map-panel-empty")!;
  const panel = document.getElementById("map-panel")!;
  const esc = (v: unknown): string =>
    String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = (n: number): string => "$" + n.toLocaleString("en-US");

  function chip(label: string, tone: string): string {
    return `<span class="map-chip" style="color:${tone};border-color:${tone}40;background:${tone}12">${esc(label)}</span>`;
  }

  function select(sel: { kind: "project" | "segment" | "evidence"; id?: string } | null): void {
    selected = sel;
    renderOverlay();
    if (!project || !sel) {
      panelEmpty.style.display = "";
      panelBody.innerHTML = "";
      panel.classList.remove("open");
      return;
    }
    panelEmpty.style.display = "none";
    panel.classList.add("open");
    if (sel.kind === "project") {
      const p = project;
      panelBody.innerHTML = `
        <div class="mp-title">${esc(p.name)}</div>
        <div class="mp-sub">${esc(p.location)}</div>
        <dl class="mp-kv">
          <dt>Budget</dt><dd class="num">${money(p.totalBudget)}</dd>
          <dt>Released</dt><dd class="num">${money(p.released)}</dd>
          <dt>Held</dt><dd class="num">${money(p.held)}</dd>
          <dt>Milestones</dt><dd>${p.milestoneCount}</dd>
          <dt>Pending approvals</dt><dd>${p.pendingApprovals}</dd>
          <dt>Ledger</dt><dd>${p.chainValid ? "CHAIN INTACT" : "TAMPERING DETECTED"}</dd>
        </dl>
        <div class="mp-actions">
          <a class="btn ghost sm" href="/project/${esc(p.id)}">View project</a>
          <a class="btn ghost sm" href="/communications">Open communications</a>
        </div>`;
    } else if (sel.kind === "segment") {
      const seg = project.segments.find((x) => x.id === sel.id);
      if (!seg) return;
      const approvalLine =
        seg.approvalStatus === "PENDING"
          ? `${seg.approvalsRecorded} of ${seg.approvalsRequired} approvals recorded`
          : seg.approvalStatus ?? "Not requested";
      // Next required action, derived from the existing state fields only.
      const nextAction =
        seg.status === "RELEASED"
          ? "Current state: Released"
          : seg.status === "APPROVED"
            ? "Release processing on the virtual account"
            : seg.status === "VERIFIED"
              ? `Next action: Awaiting governance approval (${seg.approvalsRecorded} of ${seg.approvalsRequired} recorded)`
              : seg.status === "UNDER_REVIEW"
                ? "Next action: Compliance review of flagged evidence"
                : seg.status === "PENDING_EVIDENCE"
                  ? "Next action: Submit field evidence"
                  : "Not started";
      panelBody.innerHTML = `
        <div class="mp-title">M${seg.seq} · ${esc(seg.title)}</div>
        <div class="mp-sub">${esc(seg.label)} · demo corridor segment</div>
        <div class="mp-chips">${chip(segmentStateLabel(seg.status), segmentTone(seg.status))}${chip("FUNDS " + seg.accountStatus, seg.accountStatus === "RELEASED" ? TONE.ok : TONE.warn)}</div>
        <div class="mp-next">${esc(nextAction)}</div>
        <dl class="mp-kv">
          <dt>Requirement</dt><dd>${esc(seg.requirement)}</dd>
          <dt>Tranche</dt><dd class="num">${money(seg.trancheAmount)}</dd>
          <dt>Evidence</dt><dd>${seg.evidenceCount} item${seg.evidenceCount === 1 ? "" : "s"}</dd>
          <dt>Verification</dt><dd>${seg.latestVerdict ? esc(seg.latestVerdict.replace(/_/g, " ")) : "—"}</dd>
          <dt>Approval</dt><dd>${esc(approvalLine)}</dd>
        </dl>
        <div class="mp-actions">
          <a class="btn ghost sm" href="/milestone/${esc(seg.milestoneId)}">View milestone</a>
          ${
            seg.threadId
              ? `<a class="btn ghost sm" href="/communications?thread=${esc(seg.threadId)}">Open thread</a>`
              : `<form method="POST" action="/api/threads/open" style="margin:0;display:inline"><input type="hidden" name="milestoneId" value="${esc(seg.milestoneId)}"><button class="btn ghost sm" type="submit">Open thread</button></form>`
          }
        </div>`;
    } else {
      const e = project.evidence.find((x) => x.id === sel.id);
      if (!e) return;
      panelBody.innerHTML = `
        <img class="mp-photo" src="${esc(e.photoPath)}" alt="Evidence photo M${e.seq}">
        <div class="mp-title">M${e.seq} evidence · ${esc(e.milestoneTitle)}</div>
        <div class="mp-chips">
          ${e.verdict ? chip(e.verdict.replace(/_/g, " "), evidenceTone(e)) : ""}
          ${e.isDemoFallback ? chip("DEMO FALLBACK", TONE.neutral) : ""}
          ${e.insideBoundary === false ? chip("OUTSIDE GEOFENCE", TONE.bad) : ""}
        </div>
        <dl class="mp-kv">
          <dt>Project</dt><dd>${esc(project.name)}</dd>
          <dt>Captured by</dt><dd>${esc(e.capturedBy)}</dd>
          <dt>Captured</dt><dd>${esc(e.capturedAt.replace("T", " ").slice(0, 16))} UTC</dd>
          <dt>GPS</dt><dd class="num">${e.latitude.toFixed(5)}, ${e.longitude.toFixed(5)}</dd>
          <dt>Confidence</dt><dd>${e.confidence != null ? e.confidence.toFixed(2) : "—"}</dd>
          <dt>Approval</dt><dd>${esc(e.approvalStatus ?? "Not requested")}</dd>
          <dt>Funds</dt><dd>${esc(e.accountStatus)}</dd>
          <dt>Ledger</dt><dd>${e.ledgerSeq != null ? `entry #${e.ledgerSeq}` : "not ledgered"}</dd>
        </dl>
        <div class="mp-actions">
          <a class="btn sm" href="/milestone/${esc(e.milestoneId)}">View evidence</a>
          ${
            e.threadId
              ? `<a class="btn ghost sm" href="/communications?thread=${esc(e.threadId)}">Open thread</a>`
              : `<form method="POST" action="/api/threads/open" style="margin:0;display:inline"><input type="hidden" name="milestoneId" value="${esc(e.milestoneId)}"><button class="btn ghost sm" type="submit">Open thread</button></form>`
          }
        </div>`;
    }
  }

  // ---------------- interactions ----------------
  function setZoom(z: number, aroundLngLat?: { lng: number; lat: number }): void {
    const clamped = Math.max(MIN_ZOOM, Math.min(LAYERS[activeLayer].maxZoom, z));
    if (clamped === zoom) return;
    zoom = clamped;
    if (aroundLngLat) center = { ...aroundLngLat };
    render();
  }

  zoomCtl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (btn) setZoom(zoom + Number(btn.dataset.z));
  });

  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      setZoom(zoom + (e.deltaY < 0 ? 1 : -1));
    },
    { passive: false }
  );

  // NOTE: no pointer capture here — capturing would retarget the derived
  // click events to the stage and swallow marker/segment taps.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchStart = 0;
  let moved = false;
  stage.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest(".map-zoom")) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  window.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    if (pointers.size === 1) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      const c = worldPx(center.lng, center.lat, zoom);
      const scale = TILE * Math.pow(2, zoom);
      const nx = c.x - dx;
      const ny = Math.max(0, Math.min(scale, c.y - dy));
      center = {
        lng: (nx / scale) * 360 - 180,
        lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * ny) / scale))) * 180) / Math.PI,
      };
      render();
    } else if (pointers.size === 2 && pinchStart > 0) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d / pinchStart > 1.35) {
        setZoom(zoom + 1);
        pinchStart = d;
      } else if (d / pinchStart < 0.74) {
        setZoom(zoom - 1);
        pinchStart = d;
      }
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  const endPointer = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    pinchStart = 0;
  };
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", endPointer);
  stage.addEventListener("dblclick", () => setZoom(zoom + 1));
  // Clicking empty map space clears the selection (but not after a drag).
  // Tiles have pointer-events:none, so empty-space clicks land on the
  // overlay SVG element itself (geometry/marker clicks target paths).
  stage.addEventListener("click", (e) => {
    if (moved) return;
    const t = e.target as Element;
    if (t === stage || t === (svg as unknown as Element) || t.tagName === "IMG") select(null);
  });
  window.addEventListener("resize", render);
  document.getElementById("map-panel-close")?.addEventListener("click", () => select(null));

  // ---------------- layer + filter controls ----------------
  const btnMap = document.getElementById("layer-map")!;
  const btnSat = document.getElementById("layer-sat")!;
  function setLayer(layer: "map" | "satellite"): void {
    if (layer === activeLayer) return;
    activeLayer = layer;
    zoom = Math.min(zoom, LAYERS[layer].maxZoom);
    tilesLoaded = 0;
    tilesFailed = 0;
    for (const [key, img] of tiles) {
      img.remove();
      tiles.delete(key);
    }
    btnMap.classList.toggle("active", layer === "map");
    btnSat.classList.toggle("active", layer === "satellite");
    btnMap.setAttribute("aria-pressed", String(layer === "map"));
    btnSat.setAttribute("aria-pressed", String(layer === "satellite"));
    render();
  }
  btnMap.addEventListener("click", () => setLayer("map"));
  btnSat.addEventListener("click", () => setLayer("satellite"));

  const fltBtn = document.getElementById("flt-btn")!;
  const fltPanel = document.getElementById("map-filters")!;
  function activeFilterCount(): number {
    return [filters.time, filters.milestone, filters.verdict].filter((v) => v !== "all").length;
  }
  function syncFilterButton(): void {
    const n = activeFilterCount();
    fltBtn.textContent = n > 0 ? `Filters · ${n} active` : "Filters";
  }
  function setFiltersOpen(open: boolean): void {
    fltPanel.classList.toggle("open", open);
    fltBtn.setAttribute("aria-expanded", String(open));
    if (open) (document.getElementById("flt-time") as HTMLSelectElement).focus();
  }
  fltBtn.addEventListener("click", () => setFiltersOpen(!fltPanel.classList.contains("open")));
  document.getElementById("flt-close")!.addEventListener("click", () => {
    setFiltersOpen(false);
    fltBtn.focus();
  });
  fltPanel.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") {
      setFiltersOpen(false);
      fltBtn.focus();
    }
  });
  for (const [id, key] of [
    ["flt-time", "time"],
    ["flt-milestone", "milestone"],
    ["flt-verdict", "verdict"],
  ] as const) {
    document.getElementById(id)!.addEventListener("change", (e) => {
      filters[key] = (e.target as HTMLSelectElement).value;
      syncFilterButton();
      renderOverlay();
    });
  }

  // ---------------- inset legend (only states actually present) --------
  function buildLegend(): void {
    const body = document.getElementById("legend-body");
    if (!body || !project) return;
    const line = (color: string, label: string) =>
      `<span class="lg-row"><i class="lg-line" style="background:${color}"></i>${esc(label)}</span>`;
    const dot = (color: string, label: string) =>
      `<span class="lg-row"><i class="lg-dot" style="background:${color}"></i>${esc(label)}</span>`;
    const parts: string[] = [];
    const segStates = new Map<string, string>();
    for (const seg of project.segments) {
      segStates.set(segmentStateLabel(seg.status), segmentTone(seg.status));
    }
    for (const [label, color] of segStates) parts.push(line(color, titleCase(label)));
    const evStates = new Map<string, string>();
    for (const e of project.evidence) {
      evStates.set(evidenceStateLabel(e), evidenceTone(e));
    }
    for (const [label, color] of evStates) parts.push(dot(color, "Evidence: " + titleCase(label)));
    if (project.evidence.some((e) => e.isDemoFallback)) {
      parts.push(
        `<span class="lg-row"><i class="lg-dot lg-demo"></i>Demo fallback evidence</span>`
      );
    }
    parts.push(`<span class="lg-row"><i class="lg-boundary"></i>Project boundary</span>`);
    parts.push(`<span class="lg-note">Demo corridor geometry — km labels are demonstration metadata</span>`);
    body.innerHTML = parts.join("");
  }
  function titleCase(v: string): string {
    return v.charAt(0) + v.slice(1).toLowerCase().replace(/ ([a-z])/g, (m) => m.toUpperCase());
  }
  const legendToggle = document.getElementById("legend-toggle");
  const legendBox = document.getElementById("map-legend");
  legendToggle?.addEventListener("click", () => {
    const collapsed = legendBox!.classList.toggle("collapsed");
    legendToggle.setAttribute("aria-expanded", String(!collapsed));
  });

  // ---------------- executive corridor summary -------------------------
  // Uses the seeded demo km labels ("km 7–11") when parseable; falls back
  // to segment counts. No quantities are invented beyond that metadata.
  function buildSummary(): void {
    const target = document.getElementById("map-summary");
    if (!target || !project) return;
    const buckets = new Map<string, { km: number; count: number; order: number }>();
    const ORDER: Record<string, number> = {
      "VERIFIED": 0, "AWAITING GOVERNANCE": 1, "NEEDS REVIEW": 2,
      "AWAITING EVIDENCE": 3, "NOT STARTED": 4,
    };
    let kmParsable = true;
    for (const seg of project.segments) {
      const label =
        seg.status === "RELEASED" || seg.status === "APPROVED"
          ? "VERIFIED"
          : segmentStateLabel(seg.status);
      const m = /km\s*([\d.]+)\s*[–-]\s*([\d.]+)/.exec(seg.label);
      const km = m ? Number(m[2]) - Number(m[1]) : NaN;
      if (Number.isNaN(km)) kmParsable = false;
      const b = buckets.get(label) ?? { km: 0, count: 0, order: ORDER[label] ?? 9 };
      b.km += Number.isNaN(km) ? 0 : km;
      b.count += 1;
      buckets.set(label, b);
    }
    const parts = [...buckets.entries()]
      .sort((a, b) => a[1].order - b[1].order)
      .map(([label, b]) =>
        kmParsable
          ? `<b>${fmtKm(b.km)} km</b> ${esc(label.toLowerCase())}`
          : `<b>${b.count}</b> segment${b.count === 1 ? "" : "s"} ${esc(label.toLowerCase())}`
      );
    target.innerHTML = `<span class="ms-t">Corridor status</span> ${parts.join('<span class="ms-sep">·</span>')}`;
  }
  function fmtKm(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  // ---------------- boot ----------------
  function fitToBoundary(b: Array<[number, number]>): void {
    const lngs = b.map((p) => p[0]);
    const lats = b.map((p) => p[1]);
    center = {
      lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    };
    // Pick the largest zoom that fits the boundary with padding.
    for (let z = 17; z >= MIN_ZOOM; z--) {
      const a = worldPx(Math.min(...lngs), Math.max(...lats), z);
      const c = worldPx(Math.max(...lngs), Math.min(...lats), z);
      if (c.x - a.x < stage.clientWidth - 70 && c.y - a.y < stage.clientHeight - 70) {
        zoom = z;
        return;
      }
    }
    zoom = MIN_ZOOM;
  }

  (async () => {
    try {
      const res = await fetch("/api/map-context", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data: { projects: MapProject[] } = await res.json();
      const scoped = wrap.dataset.project
        ? data.projects.filter((p) => p.id === wrap.dataset.project)
        : data.projects;
      project = scoped[0] ?? null;
      if (!project) return;
      // Populate the milestone filter from real data.
      const fm = document.getElementById("flt-milestone") as HTMLSelectElement;
      for (const seg of project.segments) {
        const opt = document.createElement("option");
        opt.value = seg.milestoneId;
        opt.textContent = `M${seg.seq} · ${seg.title}`;
        fm.appendChild(opt);
      }
      fitToBoundary(project.boundary);
      render();
      buildLegend();
      buildSummary();
      syncFilterButton();
      // On mobile the inspector is a bottom sheet over the map — keep the
      // first paint clean and open it only on explicit selection.
      if (window.matchMedia("(min-width: 861px)").matches) {
        select({ kind: "project" });
      }
    } catch {
      panelEmpty.textContent = "Map data unavailable — check your connection and reload.";
    }
  })();
})();
