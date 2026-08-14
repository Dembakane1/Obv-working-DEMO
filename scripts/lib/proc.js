/**
 * Test-harness process lifecycle.
 *
 * The server shuts down gracefully on SIGTERM: it drains in-flight
 * requests, clears timers, checkpoints and closes SQLite, then exits. So
 * `child.kill()` no longer means "the process is gone" — it means the
 * drain has STARTED. A suite that kills a server and immediately starts
 * another one against the same OBV_DATA_DIR (or the same port) is racing
 * the drain: the dying process still holds the SQLite write lock while it
 * checkpoints the WAL, and the new process refuses to start against a
 * busy database. That race is exactly what broke CI.
 *
 * Fixed sleeps are not a fix — they encode a guess about how long a drain
 * takes on a loaded CI runner. The only correct signal is the child's own
 * 'exit' event.
 */
"use strict";

/**
 * Send SIGTERM and resolve once the process has actually exited.
 *
 * Resolves with { code, signal, forced } — `forced` is true only when the
 * graceful path failed and SIGKILL was needed as last-resort cleanup.
 * That case is reported loudly: a server that cannot drain within the
 * timeout is a lifecycle regression the suite should surface, not mask.
 *
 * Safe to call on a child that already exited.
 */
function stopProcessAndWait(child, { timeoutMs = 15000, signal = "SIGTERM" } = {}) {
  return new Promise((resolve, reject) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child?.exitCode ?? null, signal: child?.signalCode ?? null, forced: false });
      return;
    }
    let forced = false;
    const killTimer = setTimeout(() => {
      forced = true;
      console.error(
        `  ! process ${child.pid} did not exit within ${timeoutMs}ms of ${signal} — ` +
          `sending SIGKILL (graceful shutdown may have regressed)`
      );
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    killTimer.unref();
    const hardTimer = setTimeout(() => {
      reject(new Error(`process ${child.pid} survived SIGKILL — cannot continue`));
    }, timeoutMs + 5000);
    hardTimer.unref();
    child.once("exit", (code, sig) => {
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      resolve({ code, signal: sig, forced });
    });
    try {
      child.kill(signal);
    } catch {
      // Exited between the check above and here.
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      resolve({ code: child.exitCode, signal: child.signalCode, forced: false });
    }
  });
}

module.exports = { stopProcessAndWait };
