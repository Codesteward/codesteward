# Enterprise session audit & subagent ledger

## Problem

Regulated customers need more than a findings list: **proof of what was reviewed**,
by **which specialist**, with **what tools/context**, **confidence**, and **verdict
chain** — recoverable after worker restarts.

## Expert panel (roles)

| Expert | Concern | Design decision |
|--------|---------|-----------------|
| **Compliance / GRC** | Tamper-evident provenance | Specialist responses stored as SHA-256 + redacted excerpt; context receipt (clone/mount, verified SHA) |
| **Security architect** | No secret leakage | Scrub tokens in notes/excerpts; never log clone tokens |
| **Staff eng (platform)** | Multi-worker safety | Postgres `FOR UPDATE SKIP LOCKED` + **job lease reclaim** for crash recovery |
| **SRE** | Resume after pod kill | Checkpoint units + re-enqueue incomplete sessions on worker boot |
| **Product / UX** | Human report | Markdown session report + per-subagent appendix + Download .md |
| **QA** | Observable runs | `specialistRuns[]` with paths, files, tools, findingsSummary, avgConfidence |

## Data model

```
SessionAudit
  context: ContextReceipt          # code plane binding
  specialistRuns[]: SpecialistRun  # one per subagent step
  tools: ToolTraceSummary          # graph/sandbox calls
  judge: JudgeNoiseSummary
  timings?: SessionTimings         # wall clocks for bottleneck analysis
  zeroFindings?: …
  heal?: …

SpecialistRun (per subagent step)
  role, unitId, unitLabel, model, runner
  startedAt, endedAt, durationMs, status
  pathsReviewed[], filesReviewed[]
  toolCallCount, usedGraph
  findingCount, findingsSummary[{title,severity,confidence,path,line}]
  avgConfidence
  responseSha256, responseExcerpt (redacted)
  stepIndex

SessionTimings
  sessionStartedAt, sessionEndedAt, totalDurationMs
  stages[]: { stage, startedAt, endedAt, durationMs, message }
  units[]:  { unitId, label, durationMs, roles, specialistMaxMs, status }
  summary:  longestStage/Unit/Specialist, byStageMs, specialistRunsSumMs, toolsSumMs
```

Stored on `review_sessions.metadata.audit` (+ live `session.audit`).  
Also denormalized as `metadata.timings` for analytics without unpacking the full audit.  
Report: `metadata.report.markdown` includes **Timing / bottlenecks** + **Subagent / specialist audit trail**.

## Resume / self-heal after worker crash

1. Checkpoint after planning/units (`session_checkpoints` + file mirror).
2. On worker start: **`reclaimStale`** → `running` jobs with expired lease → `pending`.
3. **`resumeIncompleteSessions`** enqueues resumable sessions (not blocked by zombie running rows).
4. Claim path also adopts expired leases (`STEW_JOB_LEASE_MS`, default 120s).
5. Orchestrator `resume: true` skips completed unit ids from checkpoint.

## Controls

| Env | Meaning |
|-----|---------|
| `STEW_JOB_LEASE_MS` | Stale lock age before reclaim (default 120000) |
| `STEW_SESSION_REPORT_LLM` | `0` off; default on for stewardship narrative |
| `STEW_INLINE_WORKER` | `0` = external workers only |

## Non-goals (v1)

- Cryptographic notarization / WORM storage (future: S3 Object Lock)
- Full raw LLM transcript retention by default (cost/PII) — hash + excerpt only
