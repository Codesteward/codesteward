---
sidebar_position: 2
title: "Models & providers"
description: "BYOK providers, stage matrix, and Langfuse."
---

# Models & providers

Codesteward routes specialist stages through a **model router**:

- OpenAI  
- Anthropic  
- SpaceXAI  
- OpenAI-compatible endpoints  
- LiteLLM  

## Configuration surfaces

| Surface | Use |
|---------|-----|
| **Host env** | Single-tenant dogfood (`OPENAI_API_KEY`, …) |
| **Org Models UI** | Per-org encrypted provider keys + stage matrix |
| **Platform runtime** | Install-wide knobs (platform operators) |

Org admins set **provider credentials** and which model serves which stage (planning, specialists, judge, …). Per-stage “env: API key ref” columns are **not** used — keys live on the provider.

## Langfuse

Optional dual-write tracing: org Langfuse project and/or platform Langfuse. Useful for cost and quality debugging without shipping prompts to a third SaaS review vendor.

## Cost control tips

- Start with a single strong model for all stages  
- Use cheaper models for nit-heavy or low-risk tiers  
- Cap concurrent specialists (`STEW_MAX_CONCURRENT`)  
- Prefer path-scoped stewardship on large monorepos  

UI: [Models screenshots](../product/ui-guide#12-models)
