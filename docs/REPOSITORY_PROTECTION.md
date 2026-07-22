# Repository protection — required manual steps and CI contract

The automation environment's GitHub proxy blocks repository-settings
writes, so two one-minute manual steps by the repository owner are
required. Do not consider them done until GitHub confirms them.

## 1. Make `main` the default branch (proxy-blocked here)

Attempted:

```
PATCH https://api.github.com/repos/Dembakane1/Obv-working-DEMO
  {"default_branch":"main"}
→ 403 "Repository settings writes are not permitted through this proxy."
```

Manual step: **Settings → General → Default branch → switch
`claude/obv-demo-repo-structure-t0hjsc` → `main`** (or
`gh api -X PATCH repos/Dembakane1/Obv-working-DEMO -f default_branch=main`).
Do not delete the old branch; the production Render service already
deploys from `main` regardless of the GitHub default.

## 2. Protect `main` (proxy-blocked here)

Attempted `PUT .../branches/main/protection` → 403 (same proxy policy).

Manual step — Settings → Branches → Add branch protection rule for
`main` (all supported on free-plan public repositories):

- Require a pull request before merging.
- Require status checks to pass before merging, and require the branch
  to be up to date. **Required check name: `ci`** (the job in
  `.github/workflows/ci.yml`; it appears in the picker after its first
  run).
- Require conversation resolution before merging.
- Block force pushes; block deletions.
- Do NOT require approvals (leave at 0) and do NOT enable
  "Include administrators" strictly: this repository has a single
  owner, and authors cannot approve their own pull requests — requiring
  one approval would permanently block the owner's workflow. The
  meaningful protection is the required `ci` check.

Equivalent API call once run outside the proxy:

```
gh api -X PUT repos/Dembakane1/Obv-working-DEMO/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["ci"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

## What CI enforces once the required check is set

`ci` runs on every pull request into `main`, every push to `main` and
manual dispatch: TypeScript build, every standalone suite, the VAM and
VAM-adversarial suites, the server-based suites and the deployment
configuration checks (which themselves fail if `render.yaml` stops
tracking `main` or ever configures a non-mock banking provider,
production banking mode or the production-enable flag). The workflow is
pinned to `OBV_BANKING_PROVIDER=mock` / `OBV_BANKING_MODE=demo`,
carries no secrets, uses `contents: read` permissions only, cancels
superseded runs and enforces hard timeouts.
