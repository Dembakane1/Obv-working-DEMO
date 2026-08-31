/**
 * Digital Twin interactivity — progressive enhancement over the
 * server-rendered scene.
 *
 * READ-ONLY: this script issues GET requests only, renders what they
 * return, and mutates nothing but CSS classes and the SVG viewBox. The
 * playback is a replay of recorded timeline events fetched from
 * /api/twin/playback — it never simulates or invents a frame.
 */
(() => {
  const dataEl = document.getElementById("twin-data");
  if (!dataEl) return;

  interface TwinElementMeta {
    kind: string;
    label: string;
    status: string | null;
    severity: string | null;
    detail: string | null;
    href: string | null;
    recordStatus: string;
    milestoneId: string | null;
    sourceRecordId: string;
    placed: boolean;
  }
  interface TwinClientData {
    projectId: string;
    focus: string | null;
    /** True when the server already rendered the focused event's record
     *  into the inspector — selection sync must not overwrite it. */
    eventRendered?: boolean;
    pin: string | null;
    elements: Record<string, TwinElementMeta>;
    sync: Record<string, string>;
    layers: Array<{ key: string; available: boolean; defaultOn: boolean }>;
    /** Each element's OWN recorded moment (earliest event derived from
     *  its source record) — drives Project Replay. */
    elementAt?: Record<string, string>;
    replay?: { min: string; max: string; anchor: string } | null;
  }
  interface PlaybackStep {
    eventId: string;
    at: string;
    category: string;
    type: string;
    title: string;
    explanation: string;
    elementId: string | null;
    recordStatus: string;
  }

  let data: TwinClientData;
  try {
    data = JSON.parse(dataEl.textContent ?? "{}") as TwinClientData;
  } catch {
    return;
  }

  const svg = document.getElementById("twin-scene") as unknown as SVGSVGElement | null;
  const detailTitle = document.getElementById("twin-detail-title");
  const detailBody = document.getElementById("twin-detail-body");

  // ------------------------------------------------------------ helpers
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // ------------------------------------------------------------ layers
  const layerState = new Map<string, boolean>();
  for (const l of data.layers) layerState.set(l.key, l.available && l.defaultOn);

  function applyLayers(): void {
    if (svg) {
      svg.querySelectorAll<SVGGElement>("[data-layer-group]").forEach((g) => {
        const key = g.getAttribute("data-layer-group") ?? "";
        let on = layerState.get(key) ?? true;
        if (key === "evidence") on = on && (layerState.get("gps") ?? true);
        g.style.display = on ? "" : "none";
      });
    }
    // Anchored dock groups follow the sources / inspections layers.
    document.querySelectorAll<HTMLElement>("[data-twin-dock] .twin-dock-group").forEach((g) => {
      const heading = (g.querySelector("h3")?.textContent ?? "").toLowerCase();
      let key: string | null = null;
      if (/permit|official|source/.test(heading)) key = "sources";
      if (/inspection/.test(heading)) key = "inspections";
      g.style.display = key && layerState.get(key) === false ? "none" : "";
    });
    const advisoryList = document.querySelector<HTMLElement>("[data-twin-advisory-list]");
    if (advisoryList) advisoryList.style.display = layerState.get("advisory") === false ? "none" : "";
  }
  document.querySelectorAll<HTMLInputElement>("input[data-layer-toggle]").forEach((input) => {
    input.addEventListener("change", () => {
      layerState.set(input.getAttribute("data-layer-toggle") ?? "", input.checked);
      applyLayers();
    });
  });
  applyLayers();

  // ------------------------------------------------------------ selection
  let selectedId: string | null = null;

  function clearSelection(): void {
    document.querySelectorAll(".twin-selected").forEach((n) => n.classList.remove("twin-selected"));
  }

  function renderMetaDetail(id: string, meta: TwinElementMeta): void {
    if (!detailTitle || !detailBody) return;
    detailTitle.textContent = meta.label;
    detailBody.textContent = "";
    const chips = el("p", "twin-chip-row");
    const kind = el("span", "chip neutral", meta.kind.replace(/_/g, " ").toLowerCase());
    chips.appendChild(kind);
    if (meta.status) chips.appendChild(el("span", "chip info", meta.status.replace(/_/g, " ").toLowerCase()));
    if (meta.recordStatus === "ADVISORY") chips.appendChild(el("span", "chip warn", "Advisory"));
    if (meta.severity && meta.severity !== "INFO") {
      chips.appendChild(el("span", meta.severity === "HIGH" ? "chip bad" : "chip warn", meta.severity));
    }
    detailBody.appendChild(chips);
    if (meta.detail) detailBody.appendChild(el("p", "sub", meta.detail));
    if (!meta.placed) {
      detailBody.appendChild(el("p", "sub", "This record has no recorded coordinates — it is listed, not placed."));
    }
    if (meta.href) {
      const p = el("p", "sub");
      const a = el("a", undefined, "Open the governed record →");
      a.setAttribute("href", meta.href);
      p.appendChild(a);
      detailBody.appendChild(p);
    }
  }

  function renderPinDetail(evidenceId: string): void {
    if (!detailTitle || !detailBody) return;
    detailTitle.textContent = "Evidence detail";
    detailBody.textContent = "";
    detailBody.appendChild(el("p", "sub", "Loading recorded detail…"));
    fetch(`/api/twin/pin/${encodeURIComponent(data.projectId)}/${encodeURIComponent(evidenceId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: {
        evidence: { photoPath: string; capturedAt: string; uploadedAt: string; capturedBy: string | null; hasGps: boolean };
        verification: { verdict: string; confidence: number; checks: Array<{ name: string; passed: boolean; detail: string }> } | null;
        distances: { toPlannedGeometryM: number | null; toSiteCentroidM: number | null; insideBoundary: boolean | null };
        advisorySignals: Array<{ title: string; confidence: number; explanation: string; recommendation: string }> | null;
        stage: { title: string; status: string } | null;
      }) => {
        detailBody.textContent = "";
        const img = el("img", "twin-photo") as HTMLImageElement;
        img.src = d.evidence.photoPath;
        img.alt = "Evidence photo";
        detailBody.appendChild(img);
        detailBody.appendChild(
          el("p", "sub", `Captured ${d.evidence.capturedAt.replace("T", " ").slice(0, 16)} UTC${d.evidence.capturedBy ? ` by ${d.evidence.capturedBy}` : ""}`)
        );
        if (d.stage) detailBody.appendChild(el("p", "sub", `Stage: ${d.stage.title} (${d.stage.status})`));
        if (d.verification) {
          detailBody.appendChild(
            el("p", "sub", `Verification: ${d.verification.verdict} at ${(d.verification.confidence * 100).toFixed(0)}% confidence`)
          );
          const ul = el("ul", "twin-checks");
          for (const c of d.verification.checks) {
            ul.appendChild(el("li", c.passed ? "twin-check-ok" : "twin-check-warn", `${c.name} — ${c.detail}`));
          }
          detailBody.appendChild(ul);
        }
        const dist = d.distances;
        detailBody.appendChild(
          el(
            "p",
            "sub",
            d.evidence.hasGps
              ? `Distance to planned geometry: ${dist.toPlannedGeometryM !== null ? `${dist.toPlannedGeometryM} m` : "not computable"} · site centroid: ${dist.toSiteCentroidM !== null ? `${dist.toSiteCentroidM} m` : "—"} · inside boundary: ${dist.insideBoundary === null ? "unknown" : dist.insideBoundary ? "yes" : "no"}`
              : "No GPS fix recorded — no distance is computed."
          )
        );
        if (d.advisorySignals && d.advisorySignals.length > 0) {
          const ul = el("ul", "twin-facts");
          for (const s of d.advisorySignals) {
            ul.appendChild(el("li", undefined, `Advisory: ${s.title} (${(s.confidence * 100).toFixed(0)}%) — ${s.explanation}`));
          }
          detailBody.appendChild(ul);
        }
        const p = el("p", "sub");
        const a = el("a", undefined, "Open full detail →");
        a.setAttribute("href", `/timeline/twin/${encodeURIComponent(data.projectId)}?pin=${encodeURIComponent(evidenceId)}`);
        p.appendChild(a);
        detailBody.appendChild(p);
      })
      .catch(() => {
        detailBody.textContent = "";
        detailBody.appendChild(el("p", "sub", "Detail unavailable."));
      });
  }

  function select(id: string, scroll: boolean): void {
    clearSelection();
    selectedId = id;
    const meta = data.elements[id];
    document.querySelectorAll(`[data-el="${CSS.escape(id)}"]`).forEach((n) => n.classList.add("twin-selected"));
    if (meta) {
      if (meta.kind === "EVIDENCE_PIN") renderPinDetail(meta.sourceRecordId);
      else renderMetaDetail(id, meta);
    }
    if (scroll) {
      const target = document.querySelector(`[data-el="${CSS.escape(id)}"]`);
      if (target && "scrollIntoView" in target) {
        (target as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }

  document.addEventListener("click", (ev) => {
    const target = (ev.target as HTMLElement).closest("[data-el]");
    if (!target) return;
    const id = target.getAttribute("data-el");
    if (id) select(id, false);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const target = (ev.target as HTMLElement).closest?.("[data-el]");
    if (!target) return;
    ev.preventDefault();
    const id = target.getAttribute("data-el");
    if (id) select(id, false);
  });

  // Stage rows highlight their segment.
  document.querySelectorAll<HTMLElement>("[data-stage]").forEach((row) => {
    row.addEventListener("click", () => {
      const mid = row.getAttribute("data-stage") ?? "";
      const seg = svg?.querySelector(`[data-milestone="${CSS.escape(mid)}"]`);
      const id = seg?.getAttribute("data-el");
      if (id) select(id, true);
    });
  });

  // Timeline synchronization: ?event=/?focus= highlights the element
  // that represents the event's record. Own-property lookup only — a
  // crafted focus value must not resolve Object.prototype keys, and an
  // event with no scene representation is said so, not faked.
  const focusTarget =
    data.focus && Object.prototype.hasOwnProperty.call(data.sync, data.focus)
      ? data.sync[data.focus]
      : null;
  if (typeof focusTarget === "string" && Object.prototype.hasOwnProperty.call(data.elements, focusTarget)) {
    if (data.eventRendered) {
      // The server already rendered the event's stored record into the
      // inspector; highlight its scene representation without replacing
      // that record with element metadata.
      document.querySelectorAll(`[data-el="${CSS.escape(focusTarget)}"]`).forEach((n) => n.classList.add("twin-selected"));
      const target = document.querySelector(`[data-el="${CSS.escape(focusTarget)}"]`);
      if (target && "scrollIntoView" in target) {
        (target as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
      }
    } else {
      select(focusTarget, true);
    }
  } else if (data.pin) {
    // An unknown focus never suppresses an explicit pin request.
    const pinId = `EVIDENCE_PIN:${data.pin}`;
    document.querySelectorAll(`[data-el="${CSS.escape(pinId)}"]`).forEach((n) => n.classList.add("twin-selected"));
  } else if (data.focus && !data.eventRendered && detailBody) {
    detailBody.textContent = "";
    detailBody.appendChild(
      el("p", "sub",
        "This timeline event's record has no drawn or listed representation here — open it on the Timeline for full detail.")
    );
  }

  // ------------------------------------------------- filters & replay
  // Everything below is CLIENT-SIDE VISIBILITY over data the server
  // already authorized and rendered: no fetch, no recomputation, and in
  // particular NO re-evaluation of historical readiness. Hiding is by
  // each record's OWN recorded timestamp.
  const streamList = document.getElementById("tse-stream");
  const streamCount = document.getElementById("tse-stream-count");
  const replayScrub = document.getElementById("tse-replay-scrub") as HTMLInputElement | null;
  const replayThrough = document.getElementById("tse-replay-through");
  let truthFilter = "ALL";
  let locatedOnly = false;
  let cutoffMs = Number.POSITIVE_INFINITY;
  const replayMinMs = data.replay ? Date.parse(data.replay.min) : NaN;
  const replayMaxMs = data.replay ? Date.parse(data.replay.max) : NaN;
  // Quick ranges rewind from the latest event that actually HAPPENED —
  // never from a future-dated schedule row (a recorded permit expiry).
  const replayAnchorMs = data.replay ? Date.parse(data.replay.anchor) : NaN;

  const MARKER_KINDS = new Set([
    "EVIDENCE_PIN", "INSPECTION_MARKER", "ADVISORY_MARKER",
    "PERMIT", "OFFICIAL_SOURCE", "INSPECTION",
  ]);

  function applyStreamVisibility(): void {
    if (!streamList) return;
    let visible = 0;
    streamList.querySelectorAll<HTMLElement>("li[data-at]").forEach((li) => {
      const atMs = Date.parse(li.getAttribute("data-at") ?? "");
      const truth = li.getAttribute("data-truth") ?? "";
      const located = li.getAttribute("data-located") === "1";
      const show =
        (truthFilter === "ALL" || truth === truthFilter) &&
        (!locatedOnly || located) &&
        (!Number.isFinite(cutoffMs) || !Number.isFinite(atMs) || atMs <= cutoffMs);
      li.style.display = show ? "" : "none";
      if (show) visible += 1;
    });
    if (streamCount) streamCount.textContent = String(visible);
  }

  function applyReplayToScene(): void {
    const at = data.elementAt ?? {};
    for (const id of Object.keys(at)) {
      const meta = Object.prototype.hasOwnProperty.call(data.elements, id) ? data.elements[id] : null;
      if (!meta || !MARKER_KINDS.has(meta.kind)) continue;
      const hide = Number.isFinite(cutoffMs) && Date.parse(at[id]) > cutoffMs;
      document.querySelectorAll<HTMLElement | SVGElement>(`[data-el="${CSS.escape(id)}"]`).forEach((n) => {
        n.style.display = hide ? "none" : "";
      });
    }
  }

  function setCutoff(ms: number, describeFull: boolean): void {
    cutoffMs = ms;
    // A replay window is a different question than the current selection
    // — the selection clears so a hidden record is never left "selected".
    clearSelection();
    if (replayThrough) {
      // "Entire replay window" — never "full record": the window is the
      // disclosed shown set, and any earlier history lives on the full
      // Timeline. Layer counts are not windowed and say so.
      const iso = Number.isFinite(ms) ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "";
      replayThrough.textContent = describeFull
        ? `Recorded events through: ${new Date(replayMaxMs).toISOString().replace("T", " ").slice(0, 16)} UTC (entire replay window)`
        : `Recorded events through: ${iso} UTC · layer counts are not windowed`;
    }
    applyStreamVisibility();
    applyReplayToScene();
  }

  document.querySelectorAll<HTMLButtonElement>("[data-tse-truth]").forEach((btn) => {
    btn.addEventListener("click", () => {
      truthFilter = btn.getAttribute("data-tse-truth") ?? "ALL";
      document.querySelectorAll("[data-tse-truth]").forEach((b) => b.classList.toggle("active", b === btn));
      applyStreamVisibility();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-tse-located]").forEach((btn) => {
    btn.addEventListener("click", () => {
      locatedOnly = !locatedOnly;
      btn.classList.toggle("active", locatedOnly);
      applyStreamVisibility();
    });
  });
  if (replayScrub && Number.isFinite(replayMinMs) && Number.isFinite(replayMaxMs)) {
    const span = Math.max(replayMaxMs - replayMinMs, 1);
    replayScrub.addEventListener("input", () => {
      const frac = Number(replayScrub.value) / 1000;
      const ms = replayMinMs + span * frac;
      document.querySelectorAll("[data-tse-range]").forEach((b) => b.classList.remove("active"));
      setCutoff(frac >= 1 ? Number.POSITIVE_INFINITY : ms, frac >= 1);
    });
    document.querySelectorAll<HTMLButtonElement>("[data-tse-range]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-tse-range]").forEach((b) => b.classList.toggle("active", b === btn));
        const range = btn.getAttribute("data-tse-range");
        if (range === "all") {
          replayScrub.value = "1000";
          setCutoff(Number.POSITIVE_INFINITY, true);
        } else {
          const days = Number(range);
          const anchor = Number.isFinite(replayAnchorMs) ? replayAnchorMs : replayMaxMs;
          // "Nd ago" rewinds the window; a rewind past the window's own
          // start clamps to the start — the scrubber minimum always shows
          // the window's first event, never a false empty period.
          const ms = Math.max(anchor - days * 86_400_000, replayMinMs);
          const frac = Math.min(Math.max((ms - replayMinMs) / span, 0), 1);
          replayScrub.value = String(Math.round(frac * 1000));
          setCutoff(ms, false);
        }
      });
    });
  }

  // ------------------------------------------------------------ playback
  // Playback replays EVERY recorded step the server returned, in order,
  // regardless of layer toggles — the history is the history; toggles
  // affect what is drawn on the scene, never what happened. The
  // truncation note (when the server capped a huge history) lives in its
  // own element so per-step captions can never overwrite it.
  const playBtn = document.getElementById("twin-play") as HTMLButtonElement | null;
  const speedSel = document.getElementById("twin-speed") as HTMLSelectElement | null;
  const scrub = document.getElementById("twin-scrub") as HTMLInputElement | null;
  const caption = document.getElementById("twin-play-caption");
  const playNote = document.getElementById("twin-play-note");
  let steps: PlaybackStep[] | null = null;
  let timer: number | null = null;
  let cursor = 0;

  function clearReplayState(): void {
    document.querySelectorAll(".twin-appeared, .twin-step-active").forEach((n) => {
      n.classList.remove("twin-appeared");
      n.classList.remove("twin-step-active");
    });
  }

  function stopPlayback(): void {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    if (playBtn) playBtn.textContent = "▶ Play history";
    svg?.classList.remove("twin-dimmed");
    clearReplayState();
  }

  // Mark exactly the elements whose events have happened by step i:
  // additive marking alone would misstate the scene after a backward
  // scrub, so appearance is recomputed from zero each time.
  function markAppearedUpTo(list: PlaybackStep[], i: number): void {
    clearReplayState();
    for (let k = 0; k <= i && k < list.length; k += 1) {
      const s = list[k];
      if (s.elementId) {
        document.querySelectorAll(`[data-el="${CSS.escape(s.elementId)}"]`).forEach((n) => n.classList.add("twin-appeared"));
      }
    }
  }

  function showStep(list: PlaybackStep[], i: number): void {
    document.querySelectorAll(".twin-step-active").forEach((n) => n.classList.remove("twin-step-active"));
    const s = list[i];
    if (!s) return;
    if (s.elementId) {
      document.querySelectorAll(`[data-el="${CSS.escape(s.elementId)}"]`).forEach((n) => {
        n.classList.add("twin-appeared");
        n.classList.add("twin-step-active");
      });
    }
    if (caption) {
      caption.textContent = `${s.at.slice(0, 10)} — ${s.title}${s.recordStatus === "ADVISORY" ? " (advisory)" : ""}`;
    }
    if (scrub) scrub.value = String(i);
  }

  function startPlayback(): void {
    const run = (list: PlaybackStep[]) => {
      if (list.length === 0) {
        if (caption) caption.textContent = "No recorded events to replay.";
        return;
      }
      svg?.classList.add("twin-dimmed");
      clearReplayState();
      if (scrub) {
        scrub.max = String(list.length - 1);
        scrub.value = "0";
      }
      cursor = 0;
      if (playBtn) playBtn.textContent = "⏸ Pause";
      const interval = Number(speedSel?.value ?? "900");
      timer = window.setInterval(() => {
        showStep(list, cursor);
        cursor += 1;
        if (cursor >= list.length) {
          if (timer !== null) window.clearInterval(timer);
          timer = null;
          if (playBtn) playBtn.textContent = "▶ Replay";
          if (caption) caption.textContent = `${caption.textContent} · replay complete (all ${list.length} recorded events shown)`;
          svg?.classList.remove("twin-dimmed");
        }
      }, interval);
    };
    if (steps) {
      run(steps);
      return;
    }
    fetch(`/api/twin/playback/${encodeURIComponent(data.projectId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((p: { steps: PlaybackStep[]; truncated: boolean; totalEvents: number }) => {
        steps = p.steps;
        if (p.truncated && playNote) {
          playNote.textContent =
            `Capped: replaying the most recent ${p.steps.length} of ${p.totalEvents} recorded events — the full history stays on the Timeline.`;
          playNote.style.display = "";
        }
        run(p.steps);
      })
      .catch(() => {
        if (caption) caption.textContent = "Playback unavailable.";
      });
  }

  playBtn?.addEventListener("click", () => {
    if (timer !== null) stopPlayback();
    else startPlayback();
  });
  scrub?.addEventListener("input", () => {
    if (!steps) return;
    const i = Number(scrub.value);
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
      if (playBtn) playBtn.textContent = "▶ Play history";
    }
    svg?.classList.add("twin-dimmed");
    markAppearedUpTo(steps, i);
    showStep(steps, i);
  });

  // ------------------------------------------------------------ pan/zoom
  if (svg) {
    const base = (svg.getAttribute("viewBox") ?? "0 0 1000 640").split(/\s+/).map(Number);
    let vb = [...base];
    const apply = () => svg.setAttribute("viewBox", vb.map((n) => n.toFixed(1)).join(" "));
    svg.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const factor = ev.deltaY > 0 ? 1.12 : 1 / 1.12;
        const rect = svg.getBoundingClientRect();
        const px = vb[0] + ((ev.clientX - rect.left) / rect.width) * vb[2];
        const py = vb[1] + ((ev.clientY - rect.top) / rect.height) * vb[3];
        const nw = Math.min(Math.max(vb[2] * factor, base[2] / 12), base[2] * 1.6);
        const nh = (nw / vb[2]) * vb[3];
        vb = [px - ((px - vb[0]) / vb[2]) * nw, py - ((py - vb[1]) / vb[3]) * nh, nw, nh];
        apply();
      },
      { passive: false }
    );
    let dragging = false;
    let moved = false;
    let last = { x: 0, y: 0 };
    svg.addEventListener("pointerdown", (ev) => {
      dragging = true;
      moved = false;
      last = { x: ev.clientX, y: ev.clientY };
    });
    window.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const rect = svg.getBoundingClientRect();
      const dx = ((ev.clientX - last.x) / rect.width) * vb[2];
      const dy = ((ev.clientY - last.y) / rect.height) * vb[3];
      if (Math.abs(ev.clientX - last.x) + Math.abs(ev.clientY - last.y) > 3) moved = true;
      vb[0] -= dx;
      vb[1] -= dy;
      last = { x: ev.clientX, y: ev.clientY };
      apply();
    });
    window.addEventListener("pointerup", () => {
      dragging = false;
    });
    svg.addEventListener("dblclick", () => {
      vb = [...base];
      apply();
    });
    void moved;
  }
})();
