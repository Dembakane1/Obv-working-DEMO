# Toolchain, reproducibility and dependency policy

This document records how an OBV build is made reproducible and auditable,
and why each control exists. It complements the README's quickstart with
the reasoning a lender's technical reviewer would ask for.

Every rule below is enforced by `scripts/toolchain-test.js`, which runs as
part of `npm test`. A change that quietly weakens one of these controls
fails the suite.

---

## Exact commands

```bash
npm ci                 # install the exact toolchain from package-lock.json
npm run browsers       # install the Chromium build the pinned Playwright expects
npm run browsers:deps  # same, plus Chromium's OS packages (CI / bare Linux)
npm run build          # tsc (server TSX + client TS) + generate PWA icons
npm run seed           # create data/obv.db with the seeded demo project
npm start              # serve on http://localhost:3000
npm test               # build + every suite + deployment checks (what CI runs)
npm run doctor         # environment preflight
npm run audit:prod     # production dependency surface (blocking in CI)
npm run audit          # full toolchain advisory report
```

CI runs the identical sequence — `npm ci` → `npm run browsers:deps` →
`npm run doctor` → `npm test` — from the same lockfile, on the Node version
in `.node-version`.

---

## Dependency policy

**The application has zero runtime dependencies.** It runs on Node
built-ins only (`node:http`, `node:sqlite`, `node:crypto`, `node:fs`).
`scripts/toolchain-test.js` asserts this twice: `package.json` declares no
`dependencies`/`optionalDependencies`/`peerDependencies`, *and* no file
under `src/` imports a non-`node:` module.

The consequence worth stating plainly: the production dependency surface
that could carry a vulnerability is empty. `npm run audit:prod` therefore
has nothing to audit and must always report zero — if it ever reports
anything, a runtime dependency has been introduced.

`devDependencies` are the build and test toolchain only:

| Package | Version | Why |
|---|---|---|
| `typescript` | 6.0.2 | compiles the server (TSX) and client bundles |
| `@types/node` | 25.5.0 | type definitions for the Node built-ins |
| `playwright` | 1.56.1 | drives the browser checkpoints and renders report PDFs |

All three are pinned to **exact versions** — no `^`, no `||`, no ranges.
`.npmrc` sets `save-exact=true` so a future `npm install <pkg>` cannot
reintroduce a floating range.

### Deterministic installs

`package-lock.json` is committed. Every entry carries an `integrity` hash
and a `resolved` URL, so `npm ci` installs byte-identical artifacts on a
developer machine, in CI and in the Docker image. `npm ci` also fails if
`package.json` and the lockfile disagree, which makes drift impossible to
merge silently.

### Install-time execution surface

`.npmrc` sets `ignore-scripts=true`. Dependency lifecycle scripts
(`preinstall`/`install`/`postinstall`) never execute, which removes the
largest npm supply-chain execution vector: installing a package cannot run
arbitrary code. Scripts invoked explicitly (`npm run build`, `npm test`,
`npm start`) are unaffected.

Because of this, Playwright's browser download is an explicit, auditable
step rather than an install side effect: `npm run browsers`.

`.npmrc` also sets `engine-strict=true`, so npm refuses to install under a
Node that does not satisfy `engines.node` (`>= 22.5`, required by
`node:sqlite`).

### Vulnerability auditing

Auditing reports; it never rewrites code.

- `npm run audit:prod` — `npm audit --omit=dev --audit-level=low`. Blocking
  in CI. Covers the production surface (which is empty by design), so it
  fails the moment a vulnerable runtime dependency is introduced.
- `npm audit --audit-level=critical` — blocking in CI. A CRITICAL advisory
  against the build/test toolchain stops the pull request.
- `npm run audit` — `npm audit --audit-level=high`. Advisory in CI
  (`continue-on-error`), so high/moderate toolchain advisories are visible
  without gating an unrelated pull request.

`npm audit fix` is never run anywhere: the guard suite asserts it is absent
from the workflow. Dependency changes are deliberate, reviewed commits.

---

## Browser tooling reproducibility

Playwright used to be resolved three different ways: a plain
`require("playwright")`, a fallback onto a globally installed copy via
`NODE_PATH`, and a hardcoded `/opt/pw-browsers/chromium` executable path.
CI installed a floating `playwright@1` with `--no-save`, so CI and local
runs could execute different Playwright versions against different browser
builds.

Now there is exactly one path:

- `playwright` is a pinned devDependency, so `require("playwright")`
  resolves from the project after `npm ci`;
- `scripts/lib/browser.js` is the single entry point (`launchChromium`),
  used by every browser-driven script;
- the browser build comes from `npm run browsers`, which installs the
  Chromium that the pinned Playwright expects; CI runs `npm run
  browsers:deps`, the same install plus Chromium's OS packages (splitting
  these keeps the plain command usable in restricted environments where
  `apt-get` is unavailable);
- no script contains a machine-specific browser or module path (asserted by
  the guard suite).

When Playwright or its browser is missing, the helper raises the exact
command that fixes it instead of a module-resolution stack trace.

---

## Test runner

`npm test` (`scripts/run-all-tests.js`) is the complete authoritative
validation: it builds once, runs every standalone suite, boots one
temp-seeded server for the server-based suites, and runs the deployment
configuration checks.

Diagnostics:

- the **full** stdout+stderr of every suite is written to `.test-logs/`
  (gitignored) — not just the tail;
- on failure the runner prints the failure lines, the log path, and the
  exact command to reproduce that single suite;
- `.test-logs/summary.json` records every suite result, exit code,
  checkpoint count and timing; CI uploads the directory as an artifact, so
  a failed run is diagnosable without re-running it;
- `--filter`, `--list`, `--continue`, `--verbose` and `--skip-build` are
  supported; `--verbose` now tees output instead of discarding the
  transcript, so verbose runs still produce checkpoint totals;
- a suite listed in the inventory but missing from disk is a **failure**,
  not a silent skip;
- `--skip-build` verifies `dist/` actually exists before proceeding;
- `SIGINT`/`SIGTERM` tear down the shared server, so an interrupted run
  cannot orphan a process that poisons the next run's port.

**Hermetic data.** Suites that do not create their own temp database used
to fall back to the repository's real `data/` directory, so running the
battery mutated a developer's seeded demo state and made results depend on
whatever that state happened to be. The runner now creates one freshly
seeded throwaway directory and passes it as `OBV_DATA_DIR`, and
`teams-test.js` resolves its direct database reads from that variable. A
test run no longer reads or writes the repository's `data/`.

**Banking is forced to mock/demo** by the runner regardless of the ambient
environment (`OBV_BANKING_PROVIDER=mock`, `OBV_BANKING_MODE=demo`,
`OBV_BANKING_PRODUCTION_ENABLE` cleared), and the guard suite asserts both
the runner and CI do this. `vam-test.js` separately asserts the application
refuses to start a non-mock provider without explicit production
configuration.

---

## Known limitations

- **`@types/node` (25.x) is ahead of the runtime (Node 22.x).** The type
  definitions describe newer Node APIs than the runtime ships, so `tsc`
  could in principle accept an API that does not exist at run time. The
  codebase only uses long-stable built-ins, the pin matches the vendored
  fallback exactly, and the full battery exercises the real runtime — but
  aligning `@types/node` to the 22.x line remains a worthwhile follow-up.
- **`node_modules/@types/` is still committed.** It is an offline fallback
  so `tsc` type-checks in sandboxes with no registry access. It is
  byte-identical to the version the lockfile pins (verified: `npm ci`
  produces no diff), and the guard suite fails if the two drift. Once every
  build environment can reach the registry it should be deleted.
- **The full advisory audit needs registry access.** `npm run audit`
  contacts the npm advisory endpoint; in a restricted sandbox it fails
  loudly rather than reporting a false "clean". `npm run audit:prod` works
  offline because there is nothing to audit.
- **Action versions are pinned by major tag** (`actions/checkout@v4`), not
  by commit SHA. SHA pinning is stricter supply-chain hygiene and is a
  reasonable next step if the pilot's threat model calls for it.
- **No source maps.** Server stack traces point at compiled JavaScript.
  Enabling `sourceMap` plus `--enable-source-maps` would improve
  diagnostics at a small runtime cost; it was left out of this pass to
  avoid changing runtime behaviour.
