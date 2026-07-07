/**
 * OBV Field Capture — phone-first PWA wizard.
 *
 * Primary path: real camera (getUserMedia) + real geolocation.
 * Every failure point (camera denied/unavailable, geolocation denied/
 * failed, network down) has a working fallback so a demo can never
 * dead-end:
 *   - camera fails   -> photo file upload OR seeded DEMO FALLBACK photos
 *   - GPS fails      -> simulated site coordinates (DEMO FALLBACK)
 *   - network fails  -> IndexedDB queue, auto-flushed when back online
 */

interface FieldDemoPhoto {
  id: string;
  milestoneId: string;
  path: string;
  label: string;
}

interface FieldMilestone {
  id: string;
  seq: number;
  title: string;
  requirement: string;
  trancheAmount: number;
  status: string;
  accountStatus: string;
  demoPhotos: FieldDemoPhoto[];
}

interface FieldProject {
  id: string;
  name: string;
  location: string;
  simulatedGps: { latitude: number; longitude: number };
  milestones: FieldMilestone[];
}

interface CapturedPhoto {
  kind: "camera" | "upload" | "demo";
  dataUrl?: string; // camera/upload
  demoPhoto?: FieldDemoPhoto; // demo fallback
  capturedAt: string;
  simulatedTimestamp: boolean;
}

interface LocationFix {
  latitude: number;
  longitude: number;
  simulated: boolean;
}

interface QueuedSubmission {
  id?: number;
  payload: Record<string, unknown>;
  milestoneTitle: string;
  savedAt: string;
}

(() => {
  const app = document.getElementById("app")!;
  const state = {
    projects: [] as FieldProject[],
    project: null as FieldProject | null,
    milestone: null as FieldMilestone | null,
    photo: null as CapturedPhoto | null,
    location: null as LocationFix | null,
    stream: null as MediaStream | null,
    cameraFailed: false,
  };

  const esc = (s: unknown): string =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const money = (n: number): string => "$" + n.toLocaleString("en-US");

  function deviceMetadata(): Record<string, string> {
    return {
      userAgent: navigator.userAgent,
      platform:
        (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData
          ?.platform ?? navigator.platform ?? "unknown",
      screen: `${screen.width}x${screen.height}`,
      language: navigator.language,
    };
  }

  // ------------------------------------------------------------------
  // Offline queue (IndexedDB)
  // ------------------------------------------------------------------

  function openQueueDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("obv-field", 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("queue")) {
          req.result.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function queueAdd(item: QueuedSubmission): Promise<void> {
    const db = await openQueueDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("queue", "readwrite");
      tx.objectStore("queue").add(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    updateQueuePill();
  }

  async function queueAll(): Promise<QueuedSubmission[]> {
    const db = await openQueueDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction("queue", "readonly").objectStore("queue").getAll();
      req.onsuccess = () => resolve(req.result as QueuedSubmission[]);
      req.onerror = () => reject(req.error);
    });
  }

  async function queueRemove(id: number): Promise<void> {
    const db = await openQueueDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("queue", "readwrite");
      tx.objectStore("queue").delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    updateQueuePill();
  }

  async function updateQueuePill(): Promise<void> {
    let count = 0;
    try {
      count = (await queueAll()).length;
    } catch {
      /* IndexedDB unavailable — pill simply not shown */
    }
    let pill = document.getElementById("queue-pill");
    if (count === 0) {
      pill?.remove();
      return;
    }
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "queue-pill";
      pill.className = "queue-pill";
      document.body.appendChild(pill);
    }
    pill.textContent = `${count} submission${count === 1 ? "" : "s"} queued offline — will send automatically`;
  }

  let flushing = false;
  async function flushQueue(onFlushed?: (result: unknown) => void): Promise<void> {
    if (flushing || !navigator.onLine) return;
    flushing = true;
    try {
      for (const item of await queueAll()) {
        try {
          const res = await fetch("/api/evidence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(item.payload),
          });
          if (res.ok) {
            await queueRemove(item.id!);
            if (onFlushed) onFlushed(await res.json());
          } else {
            // Permanently rejected (validation etc.) — drop so the queue
            // cannot wedge; the server recorded nothing.
            await queueRemove(item.id!);
          }
        } catch {
          break; // still offline — retry on next 'online' event
        }
      }
    } finally {
      flushing = false;
    }
  }

  window.addEventListener("online", () => flushQueue());

  // ------------------------------------------------------------------
  // Camera
  // ------------------------------------------------------------------

  async function startCamera(video: HTMLVideoElement): Promise<boolean> {
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 } },
        audio: false,
      });
      state.stream = stream;
      video.srcObject = stream;
      await video.play();
      return true;
    } catch {
      return false;
    }
  }

  function stopCamera(): void {
    state.stream?.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }

  function snapPhoto(video: HTMLVideoElement): string {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  // ------------------------------------------------------------------
  // Geolocation
  // ------------------------------------------------------------------

  function getLocation(): Promise<LocationFix> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation unsupported"));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            simulated: false,
          }),
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
      );
    });
  }

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------

  function card(html: string): string {
    return `<div class="field-card">${html}</div>`;
  }

  /** Numbered 4-step rail: 01 PROJECT → 02 MILESTONE → 03 CAPTURE → 04 REVIEW. */
  function stepsBar(current: number): string {
    const labels = ["Project", "Milestone", "Capture", "Review"];
    return `<div class="steps">${labels
      .map((label, i) => {
        const n = i + 1;
        const cls = n < current ? "done" : n === current ? "current" : "";
        const line = i > 0 ? `<span class="ln ${n <= current ? "done" : ""}"></span>` : "";
        return `${line}<span class="s ${cls}"><span class="b">${n < current ? "✓" : "0" + n}</span><span class="t">${label}</span></span>`;
      })
      .join("")}</div>`;
  }

  /** Operational status strip: connectivity + capture state. */
  function statusStrip(opts: { gps?: "pending" | "acquired" | "simulated"; time?: boolean }): string {
    const online = navigator.onLine;
    const gps = opts.gps ?? "pending";
    return `<div class="fstat">
      <span><span class="d ${online ? "on" : "warn"}"></span>${online ? "Online" : "Offline — will queue"}</span>
      <span><span class="d ${gps === "pending" ? "" : "on"}"></span>GPS ${gps === "pending" ? "on submit" : gps}</span>
      ${opts.time ? `<span><span class="d on"></span>Timestamp captured</span>` : ""}
    </div>`;
  }

  function milestoneChip(status: string): string {
    switch (status) {
      case "RELEASED": return `<span class="fchip ok">Released</span>`;
      case "APPROVED": return `<span class="fchip ok">Approved</span>`;
      case "VERIFIED": return `<span class="fchip info">Verified</span>`;
      case "UNDER_REVIEW": return `<span class="fchip info">Under review</span>`;
      case "PENDING_EVIDENCE": return `<span class="fchip warn">Awaiting evidence</span>`;
      default: return `<span class="fchip neutral">Not started</span>`;
    }
  }

  async function viewProjects(): Promise<void> {
    stopCamera();
    app.innerHTML =
      stepsBar(1) +
      card(
        `<div class="field-step">Step 1 of 4 — Project</div>
       <h3>Select project</h3>
       <div class="field-list">
         ${state.projects
           .map(
             (p, i) =>
               `<button class="field-item" data-i="${i}">
                  <span class="row1"><span class="t">${esc(p.name)}</span></span>
                  <span class="d">${esc(p.location)}</span>
                </button>`
           )
           .join("")}
       </div>`
      );
    app.querySelectorAll<HTMLButtonElement>("[data-i]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.project = state.projects[Number(btn.dataset.i)];
        viewMilestones();
      })
    );
  }

  function milestoneSelectable(m: FieldMilestone): boolean {
    return m.status === "PENDING_EVIDENCE" || m.status === "UNDER_REVIEW";
  }

  function statusLabel(status: string): string {
    return status.replace(/_/g, " ").toLowerCase();
  }

  function viewMilestones(): void {
    const p = state.project!;
    app.innerHTML =
      stepsBar(2) +
      card(
        `<div class="field-step">Step 2 of 4 — Milestone</div>
       <h3>${esc(p.name)}</h3>
       <p class="sub">Select the milestone you are submitting evidence for.</p>
       <div class="field-list">
         ${p.milestones
           .map((m, i) => {
             const enabled = milestoneSelectable(m);
             const cls = enabled ? "eligible" : "dim";
             return `<button class="field-item ${cls}" data-i="${i}" ${enabled ? "" : "disabled"}>
                <span class="row1"><span class="t">M${m.seq} · ${esc(m.title)}</span>${milestoneChip(m.status)}</span>
                <span class="d">${esc(m.requirement.length > 96 ? m.requirement.slice(0, 95) + "…" : m.requirement)}</span>
                <span class="amt">Tranche ${money(m.trancheAmount)} · funds ${m.accountStatus === "RELEASED" ? "released" : "held"}</span>
              </button>`;
           })
           .join("")}
       </div>
       <div class="field-actions"><button class="btn ghost" id="back">← Projects</button></div>`
      );
    app.querySelectorAll<HTMLButtonElement>("[data-i]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.milestone = p.milestones[Number(btn.dataset.i)];
        state.photo = null;
        state.location = null;
        viewCapture();
      })
    );
    document.getElementById("back")!.addEventListener("click", viewProjects);
  }

  async function viewCapture(): Promise<void> {
    const m = state.milestone!;
    app.innerHTML =
      stepsBar(3) +
      card(
        `<div class="field-step">Step 3 of 4 — Evidence photo</div>
       <h3>M${m.seq} · ${esc(m.title)}</h3>
       <p class="sub" style="margin-top:8px"><b style="color:#cbd5e1">Requirement:</b> ${esc(m.requirement)}</p>
       <div id="camera-zone" style="margin-top:12px">
         <video class="viewfinder" id="viewfinder" playsinline muted></video>
         ${statusStrip({})}
         <div class="field-actions">
           <button class="btn big" id="snap" disabled>Starting camera…</button>
         </div>
       </div>
       <div id="camera-fail" style="display:none">
         <div class="field-warn" id="fail-reason">Camera unavailable.</div>
       </div>
       <div class="field-actions">
         <button class="btn secondary" id="upload">Upload a photo instead</button>
         <button class="btn ghost" id="fallback">Use DEMO FALLBACK evidence</button>
         <button class="btn ghost" id="back">← Milestones</button>
       </div>
       <input type="file" id="file" accept="image/*" capture="environment" style="display:none" />
       <div id="fallback-zone" style="display:none">
         <div class="field-warn">
           <b>DEMO FALLBACK.</b> Choose a seeded evidence photo. It is submitted with
           simulated site GPS and a simulated timestamp, and is clearly labelled as
           demo fallback throughout the platform.
         </div>
         <div class="fallback-grid" id="fallback-grid">
           ${m.demoPhotos
             .map(
               (d, i) =>
                 `<button data-d="${i}"><img src="${esc(d.path)}" alt="${esc(d.label)}" /><span class="lbl">${esc(d.label)}</span></button>`
             )
             .join("")}
         </div>
         ${m.demoPhotos.length === 0 ? `<p class="field-note">No demo photos seeded for this milestone.</p>` : ""}
       </div>
       <p class="field-note">The camera and GPS of this device are the primary evidence
       path. Fallbacks exist so the demo never dead-ends on a permission screen.</p>`
      );

    const video = document.getElementById("viewfinder") as HTMLVideoElement;
    const snapBtn = document.getElementById("snap")!;
    const cameraZone = document.getElementById("camera-zone")!;
    const cameraFail = document.getElementById("camera-fail")!;

    document.getElementById("back")!.addEventListener("click", () => {
      stopCamera();
      viewMilestones();
    });

    document.getElementById("upload")!.addEventListener("click", () =>
      (document.getElementById("file") as HTMLInputElement).click()
    );
    (document.getElementById("file") as HTMLInputElement).addEventListener("change", (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        stopCamera();
        state.photo = {
          kind: "upload",
          dataUrl: String(reader.result),
          capturedAt: new Date(file.lastModified || Date.now()).toISOString(),
          simulatedTimestamp: false,
        };
        acquireLocationThenConfirm();
      };
      reader.readAsDataURL(file);
    });

    document.getElementById("fallback")!.addEventListener("click", () => {
      document.getElementById("fallback-zone")!.style.display = "block";
      document.getElementById("fallback-zone")!.scrollIntoView({ behavior: "smooth" });
    });
    document.querySelectorAll<HTMLButtonElement>("[data-d]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const demoPhoto = m.demoPhotos[Number(btn.dataset.d)];
        stopCamera();
        // Simulated capture time: 40 minutes ago, clearly flagged.
        state.photo = {
          kind: "demo",
          demoPhoto,
          capturedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
          simulatedTimestamp: true,
        };
        state.location = {
          latitude: state.project!.simulatedGps.latitude,
          longitude: state.project!.simulatedGps.longitude,
          simulated: true,
        };
        viewConfirm();
      })
    );

    const snapButton = snapBtn as HTMLButtonElement;
    snapButton.addEventListener("click", () => {
      if (!state.stream) return; // camera not ready yet
      const dataUrl = snapPhoto(video);
      stopCamera();
      state.photo = {
        kind: "camera",
        dataUrl,
        capturedAt: new Date().toISOString(),
        simulatedTimestamp: false,
      };
      acquireLocationThenConfirm();
    });

    const ok = await startCamera(video);
    state.cameraFailed = !ok;
    if (!ok) {
      cameraZone.style.display = "none";
      cameraFail.style.display = "block";
      document.getElementById("fail-reason")!.innerHTML =
        `<b>Camera unavailable or permission denied.</b> No problem — upload a photo
         from your gallery, or use the DEMO FALLBACK evidence below.`;
      document.getElementById("fallback-zone")!.style.display = "block";
    } else {
      snapButton.disabled = false;
      snapButton.textContent = "Capture evidence";
    }
  }

  async function acquireLocationThenConfirm(): Promise<void> {
    app.innerHTML =
      stepsBar(4) +
      card(
        `<div class="field-step">Location</div>
       <h3>Getting GPS fix…</h3>
       <div class="spin"></div>
       <p class="field-note" style="text-align:center">Requesting device location — you may
       be asked for permission.</p>`
      );
    try {
      state.location = await getLocation();
      viewConfirm();
    } catch {
      viewLocationFallback();
    }
  }

  function viewLocationFallback(): void {
    const p = state.project!;
    app.innerHTML =
      stepsBar(4) +
      card(
        `<div class="field-step">Location</div>
       <div class="field-warn">
         <b>GPS unavailable or permission denied.</b> Evidence needs coordinates to
         verify against the project geofence.
       </div>
       <div class="field-actions">
         <button class="btn big" id="simulate">Use simulated site GPS (DEMO FALLBACK)</button>
         <button class="btn secondary" id="retry">Retry device GPS</button>
         <button class="btn ghost" id="back">← Start over</button>
       </div>
       <p class="field-note">Simulated coordinates point at the registered project site
       (${p.simulatedGps.latitude.toFixed(4)}, ${p.simulatedGps.longitude.toFixed(4)})
       and the submission is labelled DEMO FALLBACK.</p>`
      );
    document.getElementById("simulate")!.addEventListener("click", () => {
      state.location = {
        latitude: p.simulatedGps.latitude,
        longitude: p.simulatedGps.longitude,
        simulated: true,
      };
      viewConfirm();
    });
    document.getElementById("retry")!.addEventListener("click", acquireLocationThenConfirm);
    document.getElementById("back")!.addEventListener("click", viewCapture);
  }

  function isFallbackSubmission(): boolean {
    return Boolean(
      state.photo?.kind === "demo" || state.photo?.simulatedTimestamp || state.location?.simulated
    );
  }

  function photoPreviewHtml(): string {
    const photo = state.photo!;
    const src = photo.kind === "demo" ? photo.demoPhoto!.path : photo.dataUrl!;
    return `<img class="preview" src="${esc(src)}" alt="Evidence preview" />`;
  }

  function viewConfirm(): void {
    const m = state.milestone!;
    const photo = state.photo!;
    const loc = state.location!;
    const meta = deviceMetadata();
    const fallback = isFallbackSubmission();
    app.innerHTML =
      stepsBar(4) +
      card(
        `<div class="field-step">Step 4 of 4 — Review &amp; submit</div>
       <h3>M${m.seq} · ${esc(m.title)}</h3>
       ${fallback ? `<div class="field-warn"><b>DEMO FALLBACK</b> — this submission uses ${photo.kind === "demo" ? "a seeded demo photo, " : ""}${loc.simulated ? "simulated site GPS" : ""}${photo.simulatedTimestamp ? " and a simulated timestamp" : ""}. It will be labelled as such.</div>` : `<div class="field-ok">Live capture — real camera photo and device GPS.</div>`}
       ${photoPreviewHtml()}
       ${statusStrip({ gps: loc.simulated ? "simulated" : "acquired", time: true })}
       <div class="gps-state"><span class="pulse"></span> GPS ${loc.simulated ? "simulated at project site" : "acquired from device"} · ${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}</div>
       <dl class="field-kv" style="margin-top:12px">
         <dt>Captured</dt><dd>${esc(photo.capturedAt)} ${photo.simulatedTimestamp ? "(simulated)" : "(confirmed)"}</dd>
         <dt>Device</dt><dd>${esc(meta.platform)} · ${esc(meta.screen)} · ${esc(meta.language)}</dd>
         <dt>Submitted by</dt><dd>${esc(app.dataset.userName ?? "")}</dd>
       </dl>
       <div class="field-actions">
         <button class="btn big" id="submit">Confirm &amp; submit evidence</button>
         <button class="btn ghost" id="back">← Start over</button>
       </div>`
      );
    document.getElementById("back")!.addEventListener("click", viewCapture);
    document.getElementById("submit")!.addEventListener("click", submitEvidence);
  }

  function buildPayload(): Record<string, unknown> {
    const photo = state.photo!;
    const loc = state.location!;
    return {
      milestoneId: state.milestone!.id,
      photoDataUrl: photo.kind === "demo" ? undefined : photo.dataUrl,
      demoPhotoId: photo.kind === "demo" ? photo.demoPhoto!.id : undefined,
      latitude: loc.latitude,
      longitude: loc.longitude,
      capturedAt: photo.capturedAt,
      deviceMetadata: deviceMetadata(),
      isDemoFallback: isFallbackSubmission(),
    };
  }

  async function submitEvidence(): Promise<void> {
    const payload = buildPayload();
    app.innerHTML =
      stepsBar(4) +
      card(
        `<div class="field-step">Submitting</div>
       <h3>Uploading evidence…</h3>
       <div class="spin"></div>
       <p class="field-note" style="text-align:center">Verification runs automatically on
       the server: photo vs requirement, geofence, and metadata integrity.</p>`
      );
    try {
      const res = await fetch("/api/evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        viewSubmitError(String(err.error ?? `HTTP ${res.status}`));
        return;
      }
      viewResult(await res.json());
    } catch {
      // Network failure — persist offline and keep the demo moving.
      await queueAdd({
        payload,
        milestoneTitle: state.milestone!.title,
        savedAt: new Date().toISOString(),
      });
      viewQueued();
    }
  }

  function viewSubmitError(message: string): void {
    app.innerHTML = card(
      `<div class="field-warn"><b>Submission not accepted:</b> ${esc(message)}</div>
       <div class="field-actions">
         <button class="btn big" id="retry">Back to capture</button>
       </div>`
    );
    document.getElementById("retry")!.addEventListener("click", viewCapture);
  }

  function viewQueued(): void {
    app.innerHTML = card(
      `<div class="field-step">Saved offline</div>
       <div class="field-warn"><b>No connection.</b> Your evidence is stored safely on this
       device and will upload automatically as soon as you are back online.</div>
       <div class="field-actions">
         <button class="btn big" id="trynow">Try to send now</button>
         <button class="btn ghost" id="more">Capture more evidence</button>
       </div>`
    );
    document.getElementById("trynow")!.addEventListener("click", () =>
      flushQueue((result) => viewResult(result as SubmissionResultPayload))
    );
    document.getElementById("more")!.addEventListener("click", viewMilestones);
  }

  interface SubmissionResultPayload {
    evidence: { hash: string; isDemoFallback: boolean };
    verification: {
      verdict: string;
      confidence: number;
      reasoning: string;
      checks: Array<{ name: string; passed: boolean; detail: string }>;
    };
    ledgerEntry: { seq: number; currentHash: string; previousHash: string } | null;
    approvalRequest: { requiredRoles: string[] } | null;
    milestone: { id: string; seq: number; title: string; accountStatus: string };
  }

  function viewResult(result: SubmissionResultPayload): void {
    const v = result.verification;
    const tone = v.verdict === "VERIFIED" ? "ok" : v.verdict === "NEEDS_REVIEW" ? "warn" : "bad";
    const verdictText =
      v.verdict === "VERIFIED"
        ? "VERIFIED"
        : v.verdict === "NEEDS_REVIEW"
          ? "NEEDS HUMAN REVIEW"
          : "REJECTED";
    app.innerHTML = card(
      `<div class="field-step">Verification result</div>
       <div class="verdict-banner ${tone}">${verdictText}</div>
       ${result.evidence.isDemoFallback ? `<div style="text-align:center;margin:-4px 0 10px"><span class="badge fallback">Demo fallback</span></div>` : ""}
       <ul class="checks" style="border-top:1px solid #334155">
         ${v.checks
           .map(
             (c) => `<li class="${c.passed ? "pass" : "fail"}" style="border-color:#334155">
               <span class="mark">${c.passed ? "PASS" : "FAIL"}</span>
               <span><span class="name" style="color:#e2e8f0">${esc(c.name)}</span>
               <span class="detail" style="color:#94a3b8">${esc(c.detail)}</span></span>
             </li>`
           )
           .join("")}
       </ul>
       <dl class="field-kv">
         <dt>Confidence</dt><dd>${v.confidence.toFixed(2)}</dd>
         <dt>Reasoning</dt><dd>${esc(v.reasoning)}</dd>
         <dt>Evidence hash</dt><dd style="font-family:monospace;font-size:11px">${esc(result.evidence.hash)}</dd>
         ${
           result.ledgerEntry
             ? `<dt>Ledger entry</dt><dd style="font-family:monospace;font-size:11px">#${result.ledgerEntry.seq} · ${esc(result.ledgerEntry.currentHash)}</dd>`
             : `<dt>Ledger</dt><dd>not entered (only verified evidence is ledgered)</dd>`
         }
       </dl>
       ${
         result.approvalRequest
           ? `<div class="field-ok"><b>Approval requested.</b> ${esc(
               result.approvalRequest.requiredRoles.map((r) => r.replace(/_/g, " ").toLowerCase()).join(" + ")
             )} must approve before the tranche is released. Funds remain <b>HELD</b>.</div>`
           : v.verdict === "NEEDS_REVIEW"
             ? `<div class="field-warn">A compliance reviewer will look at this submission. Funds remain HELD.</div>`
             : ""
       }
       <div class="field-actions">
         <a class="btn big" href="/milestone/${esc(result.milestone.id)}">View milestone record</a>
         <button class="btn ghost" id="more">Capture more evidence</button>
       </div>`
    );
    document.getElementById("more")!.addEventListener("click", () => {
      state.photo = null;
      state.location = null;
      loadContext().then(viewMilestonesFresh);
    });
  }

  function viewMilestonesFresh(): void {
    // Re-select the current project from the refreshed context so
    // milestone statuses are current.
    const projectId = state.project?.id;
    state.project = state.projects.find((p) => p.id === projectId) ?? state.projects[0] ?? null;
    if (state.project) viewMilestones();
    else viewProjects();
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  async function loadContext(): Promise<void> {
    const res = await fetch("/api/field-context", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.projects = (await res.json()).projects;
  }

  async function boot(): Promise<void> {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* PWA install unavailable — app still works in-browser */
      });
    }
    updateQueuePill();
    flushQueue();
    try {
      await loadContext();
      if (state.projects.length === 1) {
        state.project = state.projects[0];
        viewMilestones();
      } else {
        viewProjects();
      }
    } catch {
      app.innerHTML = card(
        `<div class="field-warn"><b>Cannot reach the OBV server.</b> Check your connection
         and try again. Any queued submissions will send automatically.</div>
         <div class="field-actions"><button class="btn big" id="retry">Retry</button></div>`
      );
      document.getElementById("retry")!.addEventListener("click", boot);
    }
  }

  boot();
})();
