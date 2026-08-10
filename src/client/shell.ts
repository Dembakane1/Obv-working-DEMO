/**
 * Application shell enhancements — theme toggle, sidebar collapse,
 * global search palette, pinned favorites, recent projects, keyboard
 * shortcuts.
 *
 * PURE PRESENTATION. This script navigates and toggles CSS state only:
 * it issues no writes, calls no API that mutates, and stores nothing but
 * the viewer's own UI preferences (theme, collapse, pins, recents) in
 * their browser's localStorage.
 */
(() => {
  const store = {
    get(key: string): string | null {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key: string, value: string): void {
      try { localStorage.setItem(key, value); } catch { /* private mode */ }
    },
  };

  // ------------------------------------------------------------ theme
  const themeBtn = document.getElementById("theme-toggle");
  const applyTheme = (t: string) => {
    document.documentElement.setAttribute("data-theme", t === "light" ? "light" : "dark");
    themeBtn?.setAttribute("aria-pressed", t === "light" ? "true" : "false");
  };
  themeBtn?.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    store.set("obv-theme", next);
    applyTheme(next);
  });
  applyTheme(document.documentElement.getAttribute("data-theme") ?? "dark");

  // ------------------------------------------------------ sidebar collapse
  const collapseBtn = document.getElementById("sidebar-collapse");
  const applyCollapse = (on: boolean) => {
    document.body.classList.toggle("sidebar-collapsed", on);
    collapseBtn?.setAttribute("aria-expanded", on ? "false" : "true");
  };
  collapseBtn?.addEventListener("click", () => {
    const next = !document.body.classList.contains("sidebar-collapsed");
    store.set("obv-sidebar", next ? "collapsed" : "open");
    applyCollapse(next);
  });
  applyCollapse(store.get("obv-sidebar") === "collapsed");

  // ------------------------------------------------------ pins & recents
  interface ProjectRef { id: string; name: string; at: number }
  const readRefs = (key: string): ProjectRef[] => {
    try {
      const parsed = JSON.parse(store.get(key) ?? "[]");
      return Array.isArray(parsed)
        ? parsed.filter((p) => p && typeof p.id === "string" && typeof p.name === "string")
        : [];
    } catch {
      return [];
    }
  };
  const writeRefs = (key: string, refs: ProjectRef[]) => store.set(key, JSON.stringify(refs.slice(0, 8)));

  // Record a visit when the current page is a project-scoped surface.
  const path = location.pathname;
  const projMatch =
    /^\/(?:projects?|timeline\/(?:project|site|story|twin|playback|map|graph))\/([^/?#]+)/.exec(path);
  if (projMatch) {
    const h1 = document.querySelector(".page-head h1, h1");
    const name = (h1?.textContent ?? "").trim();
    if (name && name.length < 120) {
      const recents = readRefs("obv-recent").filter((p) => p.id !== projMatch[1]);
      recents.unshift({ id: projMatch[1], name, at: Date.now() });
      writeRefs("obv-recent", recents);
    }
  }

  const pinsBox = document.getElementById("sidebar-pins");
  function renderPins(): void {
    if (!pinsBox) return;
    const pins = readRefs("obv-pins");
    const recents = readRefs("obv-recent").filter((r) => !pins.some((p) => p.id === r.id)).slice(0, 3);
    const rows = [...pins.map((p) => ({ ...p, pinned: true })), ...recents.map((r) => ({ ...r, pinned: false }))];
    pinsBox.querySelectorAll("a").forEach((n) => n.remove());
    if (rows.length === 0) {
      pinsBox.hidden = true;
      return;
    }
    pinsBox.hidden = false;
    for (const row of rows) {
      const a = document.createElement("a");
      a.className = "nav-item nav-pin";
      a.href = `/timeline/project/${encodeURIComponent(row.id)}`;
      const star = document.createElement("button");
      star.type = "button";
      star.className = "pin-star" + (row.pinned ? " pinned" : "");
      star.setAttribute("aria-label", row.pinned ? `Unpin ${row.name}` : `Pin ${row.name}`);
      star.textContent = row.pinned ? "★" : "☆";
      star.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const pinsNow = readRefs("obv-pins");
        if (row.pinned) writeRefs("obv-pins", pinsNow.filter((p) => p.id !== row.id));
        else writeRefs("obv-pins", [{ id: row.id, name: row.name, at: Date.now() }, ...pinsNow.filter((p) => p.id !== row.id)]);
        renderPins();
      });
      const label = document.createElement("span");
      label.className = "pin-label";
      label.textContent = row.name;
      a.appendChild(star);
      a.appendChild(label);
      pinsBox.appendChild(a);
    }
  }
  renderPins();

  // ------------------------------------------------------ command palette
  const cmdk = document.getElementById("cmdk");
  const cmdkInput = document.getElementById("cmdk-input") as HTMLInputElement | null;
  const cmdkList = document.getElementById("cmdk-list");
  interface Entry { label: string; href: string; group: string }
  // Every destination the shell knows about, including the ones that live
  // inside a consolidated workspace and therefore have no sidebar row of
  // their own. Scraping the sidebar alone would silently shrink search to
  // the twelve workspace parents and lose "Ledger", "Official Sources"
  // and the rest — reachable by tab, but no longer findable by name.
  const navIndex: Entry[] = (() => {
    const el = document.getElementById("nav-index");
    if (!el?.textContent) return [];
    try {
      const parsed: unknown = JSON.parse(el.textContent);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e): e is Entry =>
          Boolean(e) && typeof (e as Entry).label === "string" && typeof (e as Entry).href === "string"
      );
    } catch {
      return [];
    }
  })();
  function collectEntries(): Entry[] {
    const entries: Entry[] = [];
    if (navIndex.length > 0) {
      entries.push(...navIndex);
    } else {
      document.querySelectorAll<HTMLAnchorElement>(".sidebar-nav .nav-item").forEach((a) => {
        const label = (a.textContent ?? "").trim().replace(/\d+$/, "").trim();
        if (label) entries.push({ label, href: a.getAttribute("href") ?? "#", group: "Pages" });
      });
    }
    for (const p of readRefs("obv-pins")) {
      entries.push({ label: p.name, href: `/timeline/project/${encodeURIComponent(p.id)}`, group: "Pinned" });
    }
    for (const r of readRefs("obv-recent")) {
      if (!entries.some((e) => e.href.includes(r.id))) {
        entries.push({ label: r.name, href: `/timeline/project/${encodeURIComponent(r.id)}`, group: "Recent" });
      }
    }
    return entries;
  }
  let activeIndex = 0;
  let shown: Entry[] = [];
  function renderList(query: string): void {
    if (!cmdkList) return;
    const q = query.trim().toLowerCase();
    shown = collectEntries().filter((e) => !q || e.label.toLowerCase().includes(q)).slice(0, 12);
    activeIndex = 0;
    cmdkList.textContent = "";
    let lastGroup = "";
    shown.forEach((e, i) => {
      if (e.group !== lastGroup) {
        lastGroup = e.group;
        const g = document.createElement("li");
        g.className = "cmdk-group";
        g.textContent = e.group;
        cmdkList.appendChild(g);
      }
      const li = document.createElement("li");
      li.className = "cmdk-item" + (i === activeIndex ? " active" : "");
      li.setAttribute("role", "option");
      li.dataset.index = String(i);
      li.textContent = e.label;
      li.addEventListener("click", () => { location.href = e.href; });
      cmdkList.appendChild(li);
    });
    if (shown.length === 0) {
      const li = document.createElement("li");
      li.className = "cmdk-empty";
      li.textContent = "No matches — try a page name or a recently opened project.";
      cmdkList.appendChild(li);
    }
  }
  function highlight(): void {
    cmdkList?.querySelectorAll(".cmdk-item").forEach((n) => {
      n.classList.toggle("active", n instanceof HTMLElement && n.dataset.index === String(activeIndex));
    });
  }
  function openCmdk(): void {
    if (!cmdk) return;
    cmdk.hidden = false;
    renderList("");
    cmdkInput?.focus();
  }
  function closeCmdk(): void {
    if (!cmdk) return;
    cmdk.hidden = true;
    if (cmdkInput) cmdkInput.value = "";
  }
  document.getElementById("nav-search-btn")?.addEventListener("click", openCmdk);
  cmdk?.addEventListener("click", (ev) => {
    if (ev.target === cmdk) closeCmdk();
  });
  cmdkInput?.addEventListener("input", () => renderList(cmdkInput.value));
  cmdkInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); activeIndex = Math.min(activeIndex + 1, shown.length - 1); highlight(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); highlight(); }
    else if (ev.key === "Enter" && shown[activeIndex]) { location.href = shown[activeIndex].href; }
  });

  // ------------------------------------------------------ keyboard shortcuts
  const editable = (t: EventTarget | null) =>
    t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && cmdk && !cmdk.hidden) { closeCmdk(); return; }
    if (editable(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") { ev.preventDefault(); openCmdk(); }
      return;
    }
    if (ev.key === "/") { ev.preventDefault(); openCmdk(); }
    else if (ev.key === "t") { (document.getElementById("theme-toggle") as HTMLButtonElement | null)?.click(); }
    else if (ev.key === "[") { (document.getElementById("sidebar-collapse") as HTMLButtonElement | null)?.click(); }
  });
})();
