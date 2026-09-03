# OBV — OpenBuild Verify. Production demo image.
#
# Why Docker: the app itself is a zero-dependency Node server (node:http +
# node:sqlite, Node >= 22.5), but audit-grade PDF report generation needs
# headless Chromium with its system libraries. Managed "native Node"
# runtimes don't ship those; a container does, deterministically.
#
# Multi-stage: TypeScript and type stubs stay in the build stage; the
# runtime image carries only compiled output, static assets, and the
# Playwright/Chromium renderer. No secrets are baked into any layer —
# all configuration is injected via environment variables at run time.

# Base image pinned to the exact release in .node-version — the repo's single
# Node source of truth (CI runs the same patch release; node:sqlite behaviour
# has changed between 22.x patches). scripts/toolchain-test.js asserts the
# two agree.
# ---------- stage 1: compile TypeScript + generate PWA icons ----------
FROM node:22.16.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# Lockfile-exact install of the build toolchain (typescript, @types/node,
# playwright) — the same versions CI and developers use. The application
# itself has no runtime npm dependencies.
RUN set -eux && npm ci
COPY tsconfig.server.json tsconfig.client.json ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
RUN npm run build

# ---------- stage 2: runtime with Chromium for PDF rendering ----------
FROM node:22.16.0-bookworm-slim
ENV NODE_ENV=production \
    # Browsers in a fixed, cache-friendly location owned by the image.
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # Where scripts/render-pdf.js resolves the playwright module from.
    OBV_PLAYWRIGHT_NODE_PATH=/app/node_modules \
    PORT=10000
WORKDIR /app

# Playwright is the image's PDF renderer. It comes from the SAME committed
# lockfile as everywhere else, so the image, CI and developers all run one
# Playwright build. It is a devDependency, so this stage installs with the
# dev tree intact and must NOT be pruned — pruning would delete the very
# renderer this stage exists for. --with-deps pulls in Chromium's required
# system libraries via apt. Every command must fail the build if it fails:
# no `|| true` anywhere in this chain.
#
# --include=dev is NOT optional: NODE_ENV=production is set above for the
# application, and npm reads that variable as `--omit=dev` — a bare
# `npm ci` here installs NOTHING (verified: 0 packages), so the image would
# ship no Playwright module and every report would silently degrade to
# the HTML fallback. The explicit flag makes the install independent of
# NODE_ENV.
COPY package.json package-lock.json .npmrc ./
RUN set -eux \
 && npm ci --include=dev \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY scripts/render-pdf.js ./scripts/render-pdf.js
COPY scripts/lib ./scripts/lib
# Operator commands the pilot runbook runs INSIDE the deployed container
# (`npm run pilot:check`, `npm run backup`, the restore drill). They are
# plain Node scripts over dist/ and must ship with the image — package.json
# advertises them, so a missing file would be a silent runbook failure.
COPY scripts/pilot-check.js ./scripts/pilot-check.js
COPY scripts/backup.js ./scripts/backup.js
COPY scripts/backup-restore-test.js ./scripts/backup-restore-test.js

# Default (ephemeral) data location. For persistence, mount a volume and
# set OBV_DATA_DIR to its mount path (e.g. /var/data) — see render.yaml.
# The container runs as root because platform volume mounts (Render disks,
# Fly volumes) are typically root-owned; Chromium already runs with
# --no-sandbox inside the render child process.
RUN mkdir -p /app/data

EXPOSE 10000

# Seed only when the database is missing, so a mounted volume keeps its
# state across restarts/redeploys while a fresh DEMO container self-seeds.
# A declared pilot/production environment never seeds: its cold start is
# an empty schema plus the OBV_BOOTSTRAP_ADMIN_EMAIL administrator, both
# created by the server itself. (seedDemo() also refuses at the service
# level in that posture — this guard just keeps the refusal out of the
# first-boot log, where it would read as a failed boot.)
CMD ["sh", "-c", "case \"${OBV_ENVIRONMENT:-demo}\" in pilot|production) ;; *) [ -f \"${OBV_DATA_DIR:-data}/obv.db\" ] || node dist/server/db/seed.js ;; esac; exec node dist/server/http/server.js"]
