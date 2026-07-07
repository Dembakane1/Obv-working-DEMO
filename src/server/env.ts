/**
 * Environment loading — imported before anything that reads process.env at
 * module-load time (notably db/index.ts, which resolves storage paths).
 *
 * Minimal .env loader (no dependency): KEY=VALUE lines, existing environment
 * always wins, values are never logged. The file is optional; on hosted
 * deployments configuration comes from the platform's environment settings.
 */
import * as fs from "node:fs";
import * as path from "node:path";

try {
  const envFile = path.join(process.cwd(), ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
} catch {
  /* .env is optional */
}
