---
sidebar_position: 3
title: "FAQ"
description: "Common evaluation and operations questions."
---

# FAQ

### Is there a Codesteward SaaS?

**Not at this time.** Codesteward Review is self-hosted (Apache-2.0). You run the stack and bring your own LLM keys.

### Do I need Kubernetes?

No. **Docker Compose** is enough to evaluate. Helm is the production path many teams choose.

### Do I need Neo4j on day one?

For a demo, GraphQLite or mock graph may suffice. For multi-worker production, use **shared Neo4j or JanusGraph**.

### Can it review private repos?

Yes — that is a primary reason to self-host. Connect a GitHub App (or other SCM) with least privilege.

### What models work?

OpenAI, Anthropic, SpaceXAI, OpenAI-compatible endpoints, LiteLLM. Quality depends on the model; start with a strong default.

### Will it spam my PRs?

Policy severity floors, nit caps, learning suppressions, and confidence gates reduce noise. Thorough mode is more expensive and verbose — use deliberately.

### How do multi-org installs stay isolated?

Org data isolation in Postgres + workspace path layout + path jails + optional org-affine workers and strict Docker sandbox. See [Multi-tenant workers](../ops/multi-tenant-workers).

### Where do I get help?

Repository issues / discussions on GitHub, and this documentation site. Product site: [codesteward.ai](https://codesteward.ai).
