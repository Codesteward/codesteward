# Self-healing review sessions

When a specialist/unit crashes mid-review, CodeSteward **does not** fail the whole session with a bare SCM error. Units are checkpointed, healed, and the session can resume.

## Behavior

1. **Checkpoint after each unit** — unit statuses + partial finding candidates written to:
   - **Prefer** `packages/db` `unit_checkpoints` when `DATABASE_URL` is set
   - Always mirror to `.steward-data/checkpoints/{sessionId}.json` (or `STEW_CHECKPOINT_DIR` / `STEW_DATA_DIR`)
   - Session summary mirrored as `checkpoint` + `failureLog`
2. **On unit crash** — mark unit failed, append `agent_failure_log`, apply heal strategies with exponential backoff
3. **Resume** — worker re-enqueues incomplete sessions on startup; API `POST /v1/sessions/:id/resume`
4. **Degraded success** — if some units skip after max retries → session status `completed_with_errors`, findings still published
5. **GitHub** — constructive partial summary (coverage table + remaining gaps); bare failure only when zero units completed and global retries exhausted

## Heal strategies (in order)

| Order | Strategy | Effect |
| ----: | -------- | ------ |
| 1 | `retry_fresh_context` | Same runner, context annotated as fresh retry |
| 2 | `fallback_simple_runner` | DeepAgents → `SimpleAgentRunner` |
| 3 | `split_unit` | Split multi-path unit, re-queue children |
| 4 | `skip_with_gap_note` | Skip unit + severity=`info` finding *Review coverage gap* |

## Progress events (SSE / UI)

- `healing` — strategy selected for a unit
- `retry` — backoff scheduled (`delayMs`, `attempt`, `maxAttempts`)
- `unit_recovered` — unit succeeded after a heal strategy

## API

```http
POST /v1/sessions/:id/resume
GET  /v1/sessions/:id/failures
```

## Env

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `STEW_UNIT_MAX_RETRIES` | `3` | Max heal attempts per unit |
| `STEW_HEAL_BASE_BACKOFF_MS` | `500` | Backoff base |
| `STEW_HEAL_MAX_BACKOFF_MS` | `30000` | Backoff cap |
| `STEW_HEAL_SPLIT` | `1` | Set `0` to disable path split |
| `STEW_GLOBAL_MAX_RETRIES` | `3` | Session-level resume attempts |
| `STEW_CHECKPOINT_DIR` | `.steward-data/checkpoints` | Checkpoint files |

## Code

- `packages/agents/src/self-heal.ts` — backoff, strategies, checkpoint store, SCM partial summary
- `packages/agents/src/orchestrator.ts` — integrates heal + checkpoints into the unit loop
- `services/worker` — resume incomplete jobs on startup; auto-requeue on process crash
- `packages/core` — `completed_with_errors` status, healing event types, session checkpoint fields
