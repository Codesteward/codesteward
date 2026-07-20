---
sidebar_position: 5
title: "SCM connectors"
description: "GitHub App, multi-SCM, and webhooks."
---

# SCM connectors

## GitHub (recommended)

Prefer a **GitHub App** (org connector or platform-enforced shared App).

| Setting | Value |
|---------|--------|
| **Webhook URL** | `https://<public-api>/v1/webhooks/github` (API host, **not** the UI port) |
| **Webhook secret** | **Exact** same string as GitHub App → **Webhook secret** (not Client secret / not App ID) |

#### 401 Unauthorized on webhook deliveries

A **401** means the API **did** find a webhook secret and the HMAC failed.  
If **no** secret is configured and you are not in production/strict mode, the API **skips** verification (even if GitHub sends a signature).

| Local secret? | Mode | Result |
|---------------|------|--------|
| None / empty | dev | Accept (log: skipping HMAC) |
| None | production / `STEW_AUTH_STRICT=1` | **500** `webhook_secret_required` |
| Set, matches GitHub | any | **200/202** |
| Set, **mismatch** | any | **401** `invalid signature` |

So “I never set a secret” + **401** usually means a secret **is** present for the **product org** that owns the App / installation:

1. Shell / IDE / Docker: `GITHUB_WEBHOOK_SECRET` in the **same** process that runs the API  
2. **Org GitHub App** created via Connectors / manifest (`saveGitHubAppConfig`) — stored under `STEW_DATA_DIR` as `org_scm_secrets.json` / `scm_apps.json` (per **org id**, often not the string `"local"` if you created a real org)  
3. Org **Connectors → GitHub → webhookSecret**  
4. **Platform** GitHub App config `webhookSecret`  
5. Manifest create: GitHub returns `webhook_secret` once and Codesteward **persists it on the org App** — you may never have typed it, but it is still configured

The API verifies against **all** of those candidates (env → platform → installation’s org App → `local` org App → connectors). A mismatch means GitHub’s current App webhook secret ≠ any of those stored values (e.g. you rotated the secret on github.com without updating Codesteward).

**Fix options**

**A. Match secrets (recommended even for local)**  
1. GitHub App → **Webhook** → copy **Webhook secret** (not Client secret).  
2. `export GITHUB_WEBHOOK_SECRET='…'` and **restart API**.  
3. Redeliver the event.

**B. True “no secret” local dev**  
1. Unset `GITHUB_WEBHOOK_SECRET` everywhere the API process gets env from.  
2. Clear connector / platform `webhookSecret` if set.  
3. Confirm API log on delivery: `skipping HMAC verify (dev only)`.  
4. Do **not** set `NODE_ENV=production` or `STEW_AUTH_STRICT=1` without a matching secret.

Also:

- Point ngrok at the **API** (e.g. `8081`), not UI (`8080`).  
- URL path: `https://<ngrok>/v1/webhooks/github`.  
- GitHub “Recent Deliveries” response body shows `invalid signature` vs `webhook_secret_required`.

### Webhook events (subscribe)

GitHub App **default events** (manifest + manual create) should include at least:

| Event | Why |
|-------|-----|
| **`pull_request`** | Gate reviews **and** merge outcomes |
| **`issue_comment`** | `@codesteward` mention re-review / learning triage |
| **`pull_request_review_thread`** | Thread **resolved / unresolved** → soft accept / reopen of linked findings |
| `pull_request_review` | Manifest default (review submitted) |
| `pull_request_review_comment` | Manifest default (inline comments) |
| `check_run` / `check_suite` | Check runs / status integration (manifest default) |
| **`security_advisory`** | External GHSA signal → coverage / FN candidates (eval + soft focus memory) |

You do **not** subscribe to a separate “merge” event. Merges arrive as:

```text
pull_request + action=closed + pull_request.merged=true
```

Codesteward handles that as a lightweight **`pr_outcome`** job (indirect eval / learning), not a full agent re-review.

#### `pull_request` actions we use

| Action | Behavior |
|--------|----------|
| `opened` / `synchronize` / `reopened` / `ready_for_review` | Enqueue **gate** review (drafts skipped until ready) |
| `closed` **and** `merged: true` | Enqueue **outcome** analysis (address / ignore / miss candidates → consolidator) |
| `closed` unmerged, other actions | Ignored |

#### Mentions

| Setting | Value |
|---------|--------|
| Event | `issue_comment` (PR comments only) |
| Default token | `@codesteward` (`STEW_MENTION_TOKEN` to override) |
| Example | `@codesteward review` |

#### Review threads (indirect eval)

| Action | Behavior |
|--------|----------|
| `pull_request_review_thread` + **`resolved`** | Match finding by `scmCommentId` → outcome `thread_resolved` (soft accept); tag finding; consolidator may promote |
| `pull_request_review_thread` + **`unresolved`** | Outcome `thread_unresolved`; may reopen acknowledged findings |

Requires Codesteward to have **published** the review comment (so `scm_comment_id` is stored). Resolved ≠ code fixed — confidence is moderate.

#### Security advisories (coverage / FN)

| Event | Behavior |
|-------|----------|
| `security_advisory` / `repository_advisory` (`published` / `updated` / …) | Outcome `security_advisory` + soft **pattern** memory (package / GHSA); consolidator may promote important advisories to org scope |

Does **not** mean a user dismissed a Codesteward finding — it is an **external** signal for possible misses.

### Permissions (repository)

Typical App permissions (aligned with the create-from-manifest flow):

| Permission | Access | Why |
|------------|--------|-----|
| **Contents** | Read | Clone / diff for review |
| **Metadata** | Read | Repo identity |
| **Pull requests** | Write | Review comments / publish |
| **Checks** | Write | Gate check runs |
| **Statuses** | Write | Commit status when checks aren’t used |
| **Issues** | Read | PR-as-issue APIs / comments |
| **Security events** | Write (optional) | SARIF → Code Scanning (enable if you publish SARIF) |

Least privilege: start with the table above; add `security_events: write` only if you upload SARIF to GHAS.

### Manifest create

UI / API manifest registration uses `MANIFEST_DEFAULT_EVENTS` and `MANIFEST_DEFAULT_PERMISSIONS` in the product (includes `pull_request` + `issue_comment`). After create, confirm the App’s **Permissions & events** still lists those if you edited the App by hand.

Existing Apps created **before** merge-outcome support already receive `closed` on the `pull_request` event if that event is subscribed — no new event type is required. Re-check only if someone restricted delivery to a subset of actions (GitHub Apps normally deliver all actions for a subscribed event).

## GitLab

| Setting | Value |
|---------|--------|
| Webhook URL | `https://<public-api>/v1/webhooks/gitlab` (or your wired path) |
| Trigger | **Merge request events** |

| MR action | Behavior |
|-----------|----------|
| `open` / `update` / `reopen` | Gate review |
| **`merge`** | Outcome analysis (`pr_outcome`) |
| Other | Ignored |

## Other SCM

Org connectors support **Bitbucket**, **Azure DevOps**, and **Gitea** with appropriate tokens. Webhook parity for merge-outcome jobs varies; GitHub and GitLab are the primary outcome paths today.

## Platform-enforced GitHub App

Platform operators can enforce a **shared** GitHub App so tenants install the same App instead of pasting private App credentials. See Platform settings in the UI. Shared Apps must still subscribe to **`pull_request`** (including closed/merged) and **`issue_comment`** as above.

## Related

- [Findings & learning](../concepts/findings-and-learning) — merge outcomes, consolidator, repo vs org memories  
- UI: [Connectors](../product/ui-guide#10-connectors)
