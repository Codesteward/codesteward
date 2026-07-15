---
name: steward-review
description: Run CodeSteward dual-mode code review (gate or stewardship) with graph-backed specialists.
version: 1.0.0
---

# Steward Review Skill

Use this skill when the user wants a PR gate review, branch stewardship scan,
or to inspect findings/policy/graph status via CodeSteward Review.

## Prerequisites

- Monorepo built: `pnpm install && pnpm -r run build`
- Optional API: `pnpm dev:api` and worker `pnpm dev:worker`
- Graph: set `GRAPH_MOCK=1` offline, or run Codesteward MCP on `:3000`
- Models: `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `XAI_API_KEY` (mock if unset)

## Commands

```bash
# Local gate review
pnpm stew -- review -p . -r codesteward --tier full

# Stewardship scan
pnpm stew -- steward -p . -r codesteward

# Graph
pnpm stew -- graph status
pnpm stew -- graph query lexical createApp

# Policy
pnpm stew -- rules list -p .

# Config
pnpm stew -- config doctor

# Via API
pnpm stew -- review --remote -r codesteward
```

## MCP tools (stew-mcp)

- `stew_start_gate_review`
- `stew_start_stewardship`
- `stew_list_findings`
- `stew_list_sessions`
- `stew_graph_status`
- `stew_effective_policy`

## Agent workflow

1. Load policy from **base branch** checkout (`loadPolicyFromDir`).
2. Ensure graph is fresh (`graph_status` → `graph_rebuild` if needed).
3. Plan review units (file batches / packages).
4. Fan out specialists (correctness, security, rules, testing…).
5. Verify → judge (dedupe, severity floor, nit caps).
6. Persist findings; stream progress events.

## Notes

- DeepAgents plugs in via `createDeepAgentRunner` (optional peer dependency).
- Default `SimpleAgentRunner` works without deepagents installed.
- Scale: horizontal workers × `STEW_MAX_CONCURRENT` (default 8) for 50+ units.
