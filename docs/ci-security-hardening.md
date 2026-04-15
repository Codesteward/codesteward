# CI/CD Security Hardening Plan

Reference document for the GitHub Actions security and supply-chain hardening
applied to this repository (and the template for sibling repos in the Codesteward
org).

## Tech Stack Coverage

This plan covers repositories with the following characteristics:

- **Languages:** Go, Python, or TypeScript (one per repo, not mixed)
- **All repos ship container images**
- **License:** Apache 2.0
- **Commit conventions:** Conventional Commits + DCO sign-off (external contributors only)

---

## Timing Matrix — What Runs When

### On Every PR

| Check | Tool | Purpose | Fail Build? |
|-------|------|---------|-------------|
| Harden Runner | `step-security/harden-runner` | Network egress restriction, detect compromised Actions | N/A (infra) |
| DCO sign-off | `probot/dco` (GitHub App) | Enforce `Signed-off-by` on external contributor commits | Yes |
| Conventional Commits | `webiny/action-conventional-commits` | Enforce commit message format | Yes |
| Workflow security | `zizmor` | Static analysis of GitHub Actions workflows | Yes (HIGH) |
| Lint (Go) | `golangci-lint` | Static analysis | Yes |
| Lint (Python) | `ruff check` + `mypy` | Static analysis + type checking | Yes |
| Lint (TypeScript) | `eslint` + `tsc --noEmit` | Static analysis + type checking | Yes |
| Unit tests | `go test` / `pytest` / `vitest` or `jest` | Correctness | Yes |
| Dependency review | `actions/dependency-review-action` | Block PRs introducing known-vulnerable deps | Yes |
| Semgrep | `semgrep ci` | Security pattern matching (OWASP, CWE) | Yes (ERROR severity) |
| Hadolint | `hadolint/hadolint-action` | Dockerfile best practices | Yes |
| License header check | `apache/skywalking-eyes` | Ensure Apache 2.0 headers on source files | Yes |
| Markdown lint | `markdownlint-cli2` | Docs consistency | Yes |

### On Push to `main`

Everything from the PR stage, plus:

| Check | Tool | Purpose | Fail Build? |
|-------|------|---------|-------------|
| CodeQL | `github/codeql-action` | Deep interprocedural security analysis | Yes |
| govulncheck (Go) | `golang/govulncheck-action` | Reachability-aware Go vulnerability scanning | Yes |
| pip-audit (Python) | `pypa/gh-action-pip-audit` | Python dependency CVE scan against lockfile | Yes |
| npm audit (TypeScript) | `npm audit --audit-level=high` | Node dependency CVE scan | Yes |
| Container build + scan | Trivy (CLI) | Build image, scan for CVEs, fail on HIGH/CRITICAL | Yes |
| SBOM generation | syft (Anchore) | Generate CycloneDX SBOM, upload as artifact | No |
| OpenSSF Scorecard | `ossf/scorecard-action` | Repository security posture score | No |

### On Tag / Release

Everything from `main`, plus:

| Check | Tool | Purpose | Fail Build? |
|-------|------|---------|-------------|
| Container image signing | cosign (keyless via GitHub OIDC) | Sign published images with Sigstore | Yes |
| SLSA provenance | `docker/build-push-action` (`provenance: mode=max`) | Build provenance attestation (Level 2) | Yes |
| SBOM attach to release | syft | Attach CycloneDX SBOM as release asset | No |
| Trivy scan report | Trivy JSON output | Attach scan report as release asset | No |

### Scheduled (Weekly, Monday 06:00 UTC)

| Check | Tool | Purpose |
|-------|------|---------|
| CodeQL | `github/codeql-action` | Catch new CVE patterns in unchanged code |
| Trivy image scan | Trivy CLI | Catch newly published CVEs in existing images |
| govulncheck / pip-audit / npm audit | Per-language | Catch new advisories in deps |
| OpenSSF Scorecard | `ossf/scorecard-action` | Track posture drift |
| Gitleaks | `gitleaks/gitleaks-action` | Secondary secret scan (belt-and-suspenders) |
| Dependency update PRs | Renovate | Keep deps current, auto-pin Actions to SHA |

---

## DCO Configuration

Use the **probot/dco** GitHub App (not a workflow Action). Install it org-wide.

**Skip DCO for org members** — create `.github/dco.yml` on the default branch of
each repo:

```yaml
require:
  members: false
```

This enforces `Signed-off-by` only for external contributors.

---

## Trivy Usage — Hardened

1. **Install CLI binary directly** with checksum verification — not via
   `aquasecurity/trivy-action` (reduces Action-wrapper attack surface)
2. **StepSecurity Harden-Runner** blocks network egress to anything not on the
   allowlist, preventing credential exfiltration even if the tool is compromised
3. **Pin Trivy version** in the install command

```yaml
- name: Install Trivy
  run: |
    curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin v0.70.0
    trivy --version
- name: Scan image
  run: trivy image --exit-code 1 --severity HIGH,CRITICAL --format json -o trivy-report.json $IMAGE
```

---

## zizmor — GitHub Actions Workflow Security

[zizmor](https://github.com/zizmorcore/zizmor) is static analysis for GitHub
Actions workflows. Catches:

- Template injection vulnerabilities (`pull_request_target` abuse, script injection)
- Unpinned Actions (mutable tag references instead of SHA)
- Excessive permission scopes
- Credential persistence and leakage
- Impostor commits and confusable git references

This is the one tool that audits the CI/CD workflows themselves — Semgrep scans
application code, Trivy scans images, Hadolint scans Dockerfiles, zizmor scans
`.github/workflows/`.

Install via `pip install zizmor`. Outputs SARIF for the GitHub Security tab.

---

## Tool-to-Install-Method Reference

| Tool | Install Method | Notes |
|------|---------------|-------|
| Trivy | CLI binary via install script | Protected by Harden-Runner egress blocking |
| syft | CLI binary via install script | For SBOM generation |
| cosign | `sigstore/cosign-installer` (SHA-pinned) | Must be an Action for OIDC keyless signing |
| Semgrep | `pip install semgrep` | Direct CLI, no Action wrapper |
| zizmor | `pip install zizmor` | GitHub Actions workflow static analysis |
| Hadolint | `hadolint/hadolint-action` (SHA-pinned) | Minimal wrapper, acceptable |
| golangci-lint | `golangci/golangci-lint-action` (SHA-pinned) or CLI | Either is fine |
| govulncheck | `go install golang.org/x/vuln/cmd/govulncheck` | Official Go tool |
| pip-audit | `pip install pip-audit` | Direct CLI |
| Harden-Runner | `step-security/harden-runner` (SHA-pinned) | Must be an Action (needs runner hooks) |
| Renovate | GitHub App | Preferred over Dependabot (multi-ecosystem, SHA pinning) |

## What Each Tool Scans

| Layer | Tool |
|-------|------|
| Application code | Semgrep, CodeQL, golangci-lint / ruff+mypy / eslint+tsc |
| Application dependencies | govulncheck / pip-audit / npm audit, dependency-review-action |
| Container images | Trivy |
| Container build files | Hadolint |
| CI/CD workflows | **zizmor** |
| Supply chain integrity | cosign, SLSA provenance, syft (SBOM) |
| Runner protection | StepSecurity Harden-Runner |
| Repo security posture | OpenSSF Scorecard |
| Contributor compliance | probot/dco, conventional-commits, skywalking-eyes |
| Secrets | GitHub native Secret Scanning + gitleaks (scheduled) |

---

## Core Principles

1. **Every `uses:` reference must be pinned to a full commit SHA** — never a
   mutable version tag. Renovate maintains these automatically via
   `pinDigests: true`.
2. **Use StepSecurity Harden-Runner as the first step in every job**, starting
   in `egress-policy: audit` mode, moving to `block` with an allowlist once
   endpoints are known.
3. **Set explicit `permissions` blocks** on every workflow AND every job.
   Default to `contents: read`; only add permissions strictly needed.
4. **Use `persist-credentials: false`** on all `actions/checkout` steps.
5. **Prefer CLI tool installs over GitHub Action wrappers** where practical.
   Exceptions: Harden-Runner, dependency-review, CodeQL, cosign-installer,
   scorecard (must be Actions for runner hooks or OIDC).
6. **Container-scan gates publish.** On tag releases, Trivy scan runs before
   `docker push`. HIGH/CRITICAL fails the release.

---

## Target File Structure

```
.github/
  workflows/
    ci.yml              # PR + push-to-main checks
    release.yml         # Tag-triggered: build, sign, attest, publish
    scheduled.yml       # Weekly scans
    scorecard.yml       # OpenSSF Scorecard (separate for publish permissions)
  dco.yml               # probot/dco config: require.members: false
  CODEOWNERS            # Review requirements (protect .github/workflows/)
SECURITY.md             # Vulnerability disclosure policy
renovate.json           # Dependency automation
.licenserc.yaml         # skywalking-eyes config
```
