/**
 * Dashboard live-refresh: poll the server's state fingerprint and reload
 * when anything changed (evidence, verification, ledger, approvals).
 * Deliberately simple — no WebSockets in the demo build.
 */
(() => {
  let fingerprint: string | null = null;
  const INTERVAL_MS = 4000;

  async function tick(): Promise<void> {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) return;
      const data: { fingerprint: string } = await res.json();
      if (fingerprint === null) {
        fingerprint = data.fingerprint;
      } else if (data.fingerprint !== fingerprint) {
        location.reload();
      }
    } catch {
      // Offline or server restarting — try again next tick.
    }
  }

  tick();
  setInterval(tick, INTERVAL_MS);

  // Double-submit guard: after any form submits (approve/reject, generate
  // report, verify integrity, reset), disable its submit buttons so an
  // accidental second tap cannot re-post the action while the navigation
  // is in flight. Buttons with data-busy-label also show progress text
  // for the longer operations (PDF generation).
  document.addEventListener("submit", (e) => {
    const form = e.target as HTMLFormElement;
    if (!(form instanceof HTMLFormElement)) return;
    window.setTimeout(() => {
      form
        .querySelectorAll<HTMLButtonElement>("button[type=submit], button:not([type])")
        .forEach((btn) => {
          btn.disabled = true;
          const busy = btn.getAttribute("data-busy-label");
          if (busy) btn.textContent = busy;
        });
    }, 0);
  });
})();
