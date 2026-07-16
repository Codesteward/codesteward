---
sidebar_position: 1
title: "How a review works"
sidebar_label: "Review pipeline"
description: "End-to-end agent pipeline — units, specialists, judge, publish."
---

This document explains the **agent pipeline** end to end: how a job is claimed, how
**review units** and **specialists** are spawned, what each step receives and returns,
and how findings flow to the UI, PR, and (optionally) GitHub Code Scanning.

It matches the implementation in `packages/agents` (orchestrator, planner, runners,
discourse, judge, self-heal) and the worker entrypoint in `packages/api/src/run-job.ts`.

For a **visual product tour** (Dashboard, Gate form, session blade, Findings, Platform),
see [Product UI guide](/docs/product/ui-guide).

How operators experience the same pipeline in the UI:

| Pipeline stage | UI surface |
|----------------|------------|
| Enqueue / claim | Gate or Steward **Start** → session row `queued` → `running` |
| Policy → graph → plan → specialists → … | Session blade **Stage pipeline** with per-stage ms |
| Findings + report | Blade **Evidence**, **Review report**, **Reports** page |
| Provenance | Blade **Review audit** + Download audit JSON |

![Stage pipeline and narrative report in the session blade](/img/screenshots/session-blade-stage-pipeline.png)

---

## 1. Big picture

```text
  Trigger (UI / CLI / webhook / GitHub Action)
            │
            ▼
     API enqueues a ReviewJob  ──►  Postgres job queue
            │
            ▼
     Worker claims job (SKIP LOCKED / lease)
            │
            ▼
     prepareSessionWorkspace  (clone or mount code)
            │
            ▼
     ReviewOrchestrator.run()
            │
            ├─ policy / learning
            ├─ graph (optional rebuild)
            ├─ plan units
            ├─ SAST (optional)
            ├─ specialists (per unit × roles)  ◄── concurrent
            ├─ discourse (thorough only)
            ├─ verifier
            ├─ judge + noise
            ├─ prove (optional)
            ├─ persist findings + session audit
            ├─ publish (PR comments, check run, SARIF)
            └─ workspace GC (delete clones)
```

There is **no long multi-agent chat** where specialists talk to each other in a loop.
Most specialists are **one LLM turn** (or one DeepAgents tool loop) that returns **JSON
findings**. Later stages **read those findings as data**, not as chat history.

---

## 2. From click to worker

| Step | What happens |
|------|----------------|
| **Start review** | API creates a `ReviewSession` + `ReviewJob` (mode `gate` or `stewardship`, paths, risk tier, depth, SCM metadata). |
| **Queue** | Job is stored in **Postgres** (`DATABASE_URL` required; `FOR UPDATE SKIP LOCKED`). Optional NATS/Rabbit/Pulsar only *wakes* workers — they are not the job SoT. After broker data loss, workers still poll Postgres; platform operators can `POST /v1/platform/queue/republish` (or **Platform ops → Republish pending**) to rehydrate broker depth for KEDA. |
| **Claim** | A worker process calls the queue claim API and runs `runReviewJob`. |
| **Runtime config** | `applyOrgRuntimeToProcess(orgId)` paints platform/org UI settings into `process.env` for that job (e.g. DeepAgents, SARIF publish, suggested fixes). |
| **Workspace** | Prefer **SCM clone** into `{STEW_WORKSPACE_DIR}/{sessionId}` when credentials exist; else mount `REPO_PATH` (dev). Cross-repo clones go under `{sessionId}/cross/…`. |
| **Orchestrator** | Builds graph client, model router, policy from base branch, learning prompts, then runs stages below. |

Progress is streamed as events (`stage`, `unit`, `specialist_run`, `log`, …) for the UI and session audit.

---

## 3. Session stages (orchestrator)

| Stage | Purpose |
|-------|---------|
| **policy** | Load `STEWARD.md` + `.codesteward/rules` from the **base** branch; seed learning prompt. |
| **graph** | `graph_status` / optional `graph_rebuild` for the primary (and later linked) repos. |
| **planning** | Split the path list into **review units** (file batches). |
| **specialists** | Run specialist roles on each unit (self-heal on failure). |
| **discourse** | Only if `riskTier` or `depth` is **thorough**: dual correctness + synthesis. |
| **verification** | Second-pass LLM/heuristics to keep, drop, or re-score findings. |
| **judge** | Dedupe, severity floor, learning suppressions, comment cap. |
| **prove** | Optional sandbox / LLM test generation for high-severity claims. |
| **publish** | Gate mode: PR review, check run, optional Code Scanning SARIF. |
| **completed** | Persist session audit + report; **delete** session clone dir (unless `STEW_WORKSPACE_KEEP=1`). |

Checkpoints are written under the specialists stage (and after unit completion) so a crash can **resume** without redoing finished units.

---

## 4. Planning: units and roles

### Review units

The planner (`planReviewUnits`) turns the job’s path list into **units**:

| Mode | Batching | Typical batch size |
|------|----------|--------------------|
| **Gate** (PR) | Chunks of changed files | ~12 files |
| **Stewardship** | Group by package/top-level path, then chunk | ~20 files |

Each unit has:

- `id`, `label` (e.g. `gate-batch-1`, `packages/api`)
- `paths[]` — only those files/dirs
- `assignedRoles[]` — which specialist personas run on this unit
- `status` — pending → running → completed | failed | skipped

### Roles by risk tier

| Risk tier | Specialists on each unit |
|-----------|---------------------------|
| `trivial` | generalist |
| `lite` | generalist, rules |
| `full` (default) | correctness, security, rules, testing |
| `security` | correctness, security, rules, testing |
| `thorough` | correctness, security, performance, testing, rules, requirements (+ **discourse** stage later) |

`discourse` in the role list is a **marker** for thorough mode; the real discourse stage runs **after** all units, not as a peer specialist inside each unit.

---

## 5. How specialists are “spawned”

Concurrency is **unit-level**, not “one giant agent swarm”:

```text
workQueue = [unit1, unit2, unit3, …]
maxConcurrent = STEW_MAX_CONCURRENT (default 8)

while units remain:
  start up to maxConcurrent unit runners in parallel
  each unit runner (via runUnitWithHeal):
      specialistRoles = assignedRoles − {discourse}
      if runner.runUnit:
          DeepAgents → Promise.all(roles)  # roles in parallel
          Simple     → for role of roles   # roles sequential
      else:
          Promise.all(roles.map(runSpecialist))
      collect FindingCandidate[] → session candidates[]
      checkpoint unit
```

So with 3 units and 4 roles (`full` tier), you get **3 × 4 = 12** specialist LLM runs, with at most **8 units** active at once. Roles inside a unit: **parallel** on DeepAgents `runUnit`, **sequential** on SimpleAgentRunner.

### Simple runner (one turn)

`SimpleAgentRunner` → `runUnit` / `runSpecialist`:

1. Optional **graph pre-query** (lexical + referential for unit paths) → `graph_context` string  
2. Build **system** + **user** prompts from the org prompt pack (persona + guidance + JSON contract)  
3. **Single** `model.complete({ jsonMode: true, temperature: 0.1 })` per role  
4. Parse JSON → `findings[]` with optional **`reasoning`** (+ empty-scan confidence if none)  
5. Attach graph evidence to high-severity findings; score product confidence  
6. Record a **SpecialistRun** on the session audit (paths, tools, confidence, response hash)

**Turns:** typically **1 model completion per role per unit**. Roles on the same unit run **in parallel** (`Promise.all`); the unit completes only when **all** roles finish (barrier).

### DeepAgents runner (tool loop)

When `STEW_USE_DEEPAGENTS=1` (default) and the `deepagents` package loads:

1. Create a DeepAgents agent with **tools**:
   - Graph: `graph_status`, `codebase_graph_query`, optional rebuild/augment  
   - Sandbox: `sandbox_read` / exec (if sandbox session opens)  
2. Invoke with the specialist system/user content  
3. Framework may run **multiple model turns** (reason → tool call → observe → …) until it produces a final answer  
4. Final text is peeled as JSON findings (same extract path — including **`reasoning`**)

**Turns:** **variable** (tool-using loop). Not fixed in product code; bounded by the DeepAgents / model stack, not by a Codesteward “max 3 turns” constant.  
**Roles still run in parallel** with a barrier before the next pipeline stage.  
Each role is bounded by **`STEW_SPECIALIST_TIMEOUT_MS`** (default **8 minutes**). On timeout the role soft-fails and sibling findings still merge — so one hung model/tool loop cannot freeze the session.  
**Rate limits:** Simple runner uses ModelRouter `fetchWithLlmRetry` (429/5xx + `Retry-After`). DeepAgents does **not** go through that path — it uses LangChain models with `maxRetries` (`STEW_LLM_MAX_RETRIES`, default 4) and per-call `timeout` (`STEW_LLM_REQUEST_TIMEOUT_MS`, default 120s). Parallel roles × units can still trip provider quotas; lower `STEW_MAX_CONCURRENT` / `STEW_MAX_SPECIALISTS_PER_UNIT` if heartbeats stall.  
If DeepAgents cannot load and `STEW_REQUIRE_TOOL_AGENTS=1`, the unit **fails** rather than silently using simple chat.

### Self-heal (when a unit fails)

`runUnitWithHeal` can, in order:

1. **retry_fresh_context** — same roles, refreshed context  
2. **fallback_simple_runner** — force SimpleAgentRunner  
3. **split_unit** — split paths into child units and re-queue  
4. **skip_with_gap_note** — mark skipped and emit a coverage-gap style note  

Failures are appended to `failureLog` and checkpoints so resume can continue.

---

## 6. What a specialist receives

Each specialist call is a **SpecialistContext**:

| Input | Source | Typical size / notes |
|-------|--------|----------------------|
| **System prompt** | Prompt pack persona + role guidance + locked JSON output contract | Includes severity floor, path rules, learning block |
| **User prompt** | Unit label, path list, packed **context_text**, **graph_context** | Context truncated (~16k chars code/diff, ~6k graph) |
| **Policy** | Base-branch `STEWARD.md` + path rules | Severity floor, nits, ignore globs |
| **Learning** | Org/repo/PR memories, 👎 suppressions | Injected into system as `org_learning` |
| **Graph** | Pre-fetched hits and/or live tools (DeepAgents) | Optional if `GRAPH_MOCK=1` or MCP down |
| **Session / unit ids** | For audit + Langfuse grouping | Same `sessionId` across all LLM calls |

**Gate** packs **diff** context; **stewardship** packs **file** excerpts for the unit paths.

Specialists do **not** receive other specialists’ raw chat transcripts. They only share the **same packed context** for that unit (and later stages see **structured findings**).

---

## 7. What a specialist returns

Expected JSON (simplified):

```json
{
  "findings": [
    {
      "title": "…",
      "body": "…",
      "path": "src/foo.ts",
      "startLine": 42,
      "endLine": 48,
      "category": "security",
      "severity": "high",
      "confidence": 0.85,
      "suggestion": "…",
      "suggestedFix": "…",
      "ruleIds": ["…"]
    }
  ],
  "emptyScanConfidence": 0.8
}
```

| Field | Meaning |
|-------|---------|
| **findings[]** | Candidate issues (may be empty). |
| **reasoning** | Structured specialist rationale (why real, what was checked, caveats) — **not** a multi-turn chat log. Persisted on the finding and as `evidence.type = "reasoning"`. |
| **confidence** (per finding) | Model self-report → stored as `modelConfidence`; product `confidence` is **re-scored** from evidence. |
| **emptyScanConfidence** | When `findings` is empty: how sure the model is nothing was missed → feeds **empty-scan** product confidence on the specialist run. |
| **suggestedFix** | Only if org/platform allows `STEW_SUGGESTED_CODE_FIXES` and product confidence ≥ min threshold. |

Outputs become **`FindingCandidate[]`**, merged into the session’s `candidates` list. Later stages (especially the **senior verifier**) read this structured list — not specialist transcripts.

---

## 8. How data flows between “agents”

There is **no** agent A → agent B chat pipe. Flow is **dataflow**:

```text
  Unit A: correctness ──┐
  Unit A: security   ──┼──► candidates[]
  Unit A: rules      ──┤
  Unit B: …          ──┘
            │
            ▼
     [discourse?]  (thorough only)
            │  dual correctness passes + AGREE/CHALLENGE/CONNECT/SURFACE
            │  merges / boosts / drops candidates
            ▼
       verifier   (LLM/heuristic keep|drop|adjust)
            │
            ▼
       judge/noise  (dedupe, severity floor, learning suppress, comment cap)
            │
            ▼
       [prove?]   (sandbox / generated tests for some findings)
            │
            ▼
   Findings store + session.audit.specialistRuns[]
            │
            ├─► UI / reports
            ├─► PR comments + check run (gate)
            └─► GitHub Code Scanning SARIF (if enabled)
```

### Discourse (thorough only)

1. **Pass A** — independent correctness review (one framing/temperature)  
2. **Pass B** — second independent correctness review  
3. **Synthesis** — JSON notes: `AGREE` | `CHALLENGE` | `CONNECT` | `SURFACE`  
4. Merge: AGREE boosts product confidence; CHALLENGE can drop; SURFACE can introduce findings  

Still **not** a free-form multi-turn debate between specialists—three structured LLM calls over the candidate set.

### Verifier / judge

- **Verifier (senior SWE)**: after the specialist **barrier**, batches candidates with **`reasoning`**, evidence summaries, roles, confidences, and packed review context. Strong model (`verifier` role). Returns keep/drop/downgrade/upgrade per index. Batches can run in parallel.  
- **Judge**: mostly **deterministic** noise stack — fingerprint dedupe, severity floor, 👎 memories, prior-finding awareness, **comment cap**. Does not re-read specialist chats.

---

## 9. Models and routing

`ModelRouter` picks provider/model **per role** (org matrix or env), e.g. stronger model for `security` / `judge` if configured.

- Simple path: OpenAI-compatible / Anthropic chat completions, `jsonMode` where supported.  
- DeepAgents path: LangChain chat model with the same org keys/base URL when possible.  
- Optional **Langfuse**: all generations for a review share `sessionId` = Codesteward session id.

---

## 10. Session audit (what you see in the UI)

Each specialist step appends a **SpecialistRun**:

| Field | Example use |
|-------|-------------|
| `role`, `unitLabel`, `model`, `runner` | Who ran, on which batch, with which model |
| `pathsReviewed`, `filesReviewed` | Scope |
| `toolCallCount`, `usedGraph` | Tools / graph grounding |
| `findingCount`, `findingsSummary` | Titles + confidences (or “No findings” + empty-scan conf) |
| `avgConfidence` | Mean finding confidence, or empty-scan product score |
| `responseSha256`, `responseExcerpt` | Provenance without full secret-laden payload |

That ledger is how you answer: *“Did security look at this package, and how sure was an empty result?”*

---

## 11. Self-heal and resume

| Mechanism | Behavior |
|-----------|----------|
| **Checkpoint** | After units progress: units status, candidates, strategies, failure log |
| **Resume** | API `POST /v1/sessions/:id/resume` re-enqueues; orchestrator skips completed units |
| **Worker reclaim** | Stale job leases reclaimed on worker boot |
| **Workspace GC** | On terminal status, delete `{STEW_WORKSPACE_DIR}/{sessionId}` unless `STEW_WORKSPACE_KEEP=1` |

---

## 12. Publish surfaces (gate)

After findings are final:

1. **PR review** — summary + capped inline comments (line-relocated)  
2. **Check run** — `codesteward/gate` for branch protection  
3. **SARIF → Code Scanning** — if `STEW_PUBLISH_SARIF` effective On and GitHub supports it  

Stewardship mode typically **does not** post a PR review; findings live in the product store/UI (and optional SARIF export via CLI).

---

## 13. Mental model (one sentence each)

| Question | Answer |
|----------|--------|
| Who spawns subagents? | The **orchestrator**, one **unit** at a time (up to N concurrent units). |
| What is a subagent? | A **role** (correctness, security, …) on that unit’s paths. |
| How many LLM turns? | **Simple:** 1 completion/role. **DeepAgents:** multi-turn tool loop until final JSON. **Discourse:** +2 correctness + 1 synthesis when thorough. |
| Do agents talk to each other? | **No.** They produce findings; later stages transform the **shared list**. |
| Where does context come from? | Packed **diff/files** + **policy** + **learning** + **graph** (+ tools for DeepAgents). |
| How do I debug a run? | Session **audit** / specialist ledger + Langfuse session id + worker logs. |
| How long did each step take? | `session.audit.timings` (also `metadata.timings`): stages, units, specialist `durationMs`, rollup summary for bottlenecks. |

---

## 14. Worked example: one PR gate review

This is a **narrative walkthrough** of a small PR so you can picture spawns, turns, and handoffs. Numbers and paths are illustrative; the shape matches production.

### Setup

| Field | Example value |
|-------|----------------|
| Trigger | GitHub Action / UI on PR `#42` |
| Mode | `gate` |
| Risk tier | `full` (not thorough → **no discourse**) |
| Paths changed | `src/auth/login.ts`, `src/auth/session.ts`, `src/api/users.ts` |
| Runner | DeepAgents available (`STEW_USE_DEEPAGENTS=1`) |
| Concurrency | `STEW_MAX_CONCURRENT=8` |

### Timeline

```text
t0  API: create session ses_abc + job job_xyz → queue
t1  Worker claims job; applyOrgRuntimeToProcess(org)
t2  Clone repo → /workspace/ses_abc (or REPO_PATH mount in dev)
t3  Orchestrator stages: policy → graph → planning → specialists → …
```

### Stage: policy + graph + planning

1. **Policy** loads `STEWARD.md` + `.codesteward/rules` from the **base** branch (not the PR head).  
2. **Graph** may `graph_rebuild` if stale; otherwise reuse.  
3. **Planner** sees 3 files → **1 unit** (under gate batch size ~12):

```text
unit gate-batch-1
  paths: [src/auth/login.ts, src/auth/session.ts, src/api/users.ts]
  assignedRoles: [correctness, security, rules, testing]
```

Packed **user context** ≈ unified diff for those paths (gate mode), truncated if huge.

### Stage: specialists (the “subagents”)

The orchestrator does **not** open a chat room. It calls `runUnitWithHeal` for `gate-batch-1`, which calls `activeRunner.runUnit(roles, ctx)`.

With DeepAgents, the four roles start **in parallel** (same packed context, different system personas):

```text
                    ┌─ correctness  ── LLM(+tools) ──► findings_c[]
  gate-batch-1  ────┼─ security     ── LLM(+tools) ──► findings_s[]
  (shared ctx)      ├─ rules        ── LLM(+tools) ──► findings_r[]
                    └─ testing      ── LLM(+tools) ──► findings_t[]
                              │
                              ▼
                   candidates = flat(all findings_*)
                   checkpoint(unit completed)
```

#### What each spawn gets (SpecialistContext)

| Piece | Example |
|-------|---------|
| **System** | Persona for that role + org guidance + “return JSON findings only” contract + learning suppressions |
| **User** | `Unit: gate-batch-1` + path list + packed diff + optional pre-fetched graph snippets |
| **Tools** (DeepAgents only) | `codebase_graph_query`, `graph_status`, optional sandbox read/exec |
| **Not included** | Other roles’ prompts, other roles’ answers, prior chat history |

Simple runner only: graph is **pre-queried** for security/correctness (lexical + referential on basenames) and stuffed into the user message—then **one** `model.complete(jsonMode)`.

#### Turns (DeepAgents security example)

```text
Turn 1  model: “I need callers of parseToken”
        tool:  codebase_graph_query(referential, "parseToken")
Turn 2  model: observes graph hits; “read session.ts around line 80”
        tool:  sandbox_read / graph query …
Turn 3  model: final message → JSON { "findings": [ … ] }
```

- **Simple runner:** always **1** completion (no tool loop).  
- **DeepAgents:** **N** turns until final text; N is not a fixed product constant.  
- Failed DeepAgents unit can self-heal → `fallback_simple_runner` (1 turn each role).

#### Example security response (parsed)

```json
{
  "findings": [
    {
      "title": "Session cookie missing Secure flag",
      "body": "setCookie() in session.ts does not set Secure in production.",
      "path": "src/auth/session.ts",
      "startLine": 88,
      "severity": "high",
      "category": "security",
      "confidence": 0.9
    }
  ]
}
```

Product code then:

1. Extracts → `FindingCandidate[]`  
2. Re-scores **product confidence** from evidence (model’s 0.9 becomes `modelConfidence`)  
3. Optionally strips `suggestedFix` if below org min confidence  
4. Appends a **SpecialistRun** row on the session audit  
5. Pushes into shared `candidates[]`

Correctness / rules / testing do the same independently. They never read security’s JSON; the orchestrator **merges lists**.

### After all units: dataflow stages (not chat)

Assume candidates now has 5 items (1 security, 2 correctness, 1 rules, 1 testing).

| Stage | LLM turns (typical) | Input | Output |
|-------|---------------------|--------|--------|
| **Discourse** | *skipped* (tier ≠ thorough) | — | — |
| **Verifier** | ~1 batch pass | `candidates[]` | keep / drop / adjust |
| **Judge + noise** | 0–1 (mostly code) | verified list | deduped, severity floor, comment cap |
| **Prove** | optional | high-severity subset | pass/fail evidence |
| **Publish** | 0 | final findings | PR review, check run, optional SARIF |

If tier had been **thorough**, between specialists and verifier:

```text
Pass A  correctness (framing A)  ──┐
Pass B  correctness (framing B)  ──┼──► synthesis LLM
Existing candidates              ──┘         │
                                             ▼
                              AGREE / CHALLENGE / CONNECT / SURFACE
                              → merge boosts/drops into candidates[]
```

Still structured JSON moves—not free-form agent debate.

### What the UI / audit shows

For this session you might see four specialist rows:

| Role | Runner | Findings | Avg conf | Tools |
|------|--------|----------|----------|-------|
| correctness | deepagents | 2 | 0.78 | 4 |
| security | deepagents | 1 | 0.91 | 6 |
| rules | deepagents | 1 | 0.72 | 0 |
| testing | deepagents | 1 | 0.65 | 1 |

Empty specialist → row still present with `emptyScanConfidence` so “no findings” is auditable.

### Handoff summary (who talks to whom)

```text
  User / SCM
      │
      ▼
  Worker + Orchestrator          ← only “conductor”; holds candidates[]
      │
      ├──► Specialist(role)×N     ← isolated; return findings only
      │         │
      │         └── findings ──► candidates[]  (merge, no reply channel)
      │
      ├──► Discourse (optional)   ← reads candidates + context; writes merged list
      ├──► Verifier               ← reads candidates; writes filtered list
      ├──► Judge                  ← reads filtered; writes final findings store
      └──► Publish / GC
```

**Key insight:** “Subagent” here means **one role invocation on one unit’s context**, not a persistent agent with memory of siblings. Later stages see **structured findings**, not transcripts.

### If something fails mid-unit

```text
security throws / times out
  → self-heal: retry_fresh_context
  → still fails → fallback_simple_runner (1 turn, no tools)
  → still fails → split_unit (re-queue smaller path batches)
  → last resort → skip_with_gap_note
Checkpoint keeps completed siblings; resume skips them.
```

---

## 15. Related docs

| Doc | Topic |
|-----|--------|
| [Session audit](/docs/security/session-audit) | Audit fields, compliance lens |
| Code: `packages/agents/src/orchestrator.ts` | Stage machine |
| Code: `packages/agents/src/planner.ts` | Units & roles |
| Code: `packages/agents/src/specialists.ts` / `deep-agent-runner.ts` | Per-role execution |
| Code: `packages/agents/src/discourse.ts` | Thorough dual-pass |
| Code: `packages/api/src/run-job.ts` | Worker job wrapper + workspace GC |

---

*Last aligned with the Codesteward Review agent pipeline as implemented in this repository.*
