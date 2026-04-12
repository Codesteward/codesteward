# Docker Setup (Neo4j / JanusGraph)

Use Docker when you need a persistent graph server shared across teams,
or raw Cypher/Gremlin query support.

For local development, the [automatic setup](README.md) with GraphQLite is
simpler and requires no Docker.

## Docker + Neo4j

```bash
# 1. Point the server at your repository
export REPO_PATH=/path/to/your/repository

# 2. Start Neo4j + MCP server
docker compose -f docker-compose.neo4j.yml up -d

# 3. Copy config templates into the repo you want to analyse
cp templates/.mcp.json /path/to/your/repository/
cp templates/CLAUDE.md /path/to/your/repository/
```

The server runs at `http://localhost:3000/sse`. Call `graph_rebuild()` with
no arguments — the server already knows the repo path from the volume mount.

## Docker + JanusGraph (Apache 2.0)

```bash
export REPO_PATH=/path/to/your/repository
docker compose -f docker-compose.janusgraph.yml up -d
cp templates/.mcp.json /path/to/your/repository/
cp templates/CLAUDE.md /path/to/your/repository/
```

Same workflow as Neo4j — all named query templates work identically. Raw
query passthrough uses Gremlin instead of Cypher.

## Manual Docker run

```bash
docker run -p 3000:3000 \
  -v /path/to/your/repo:/repos/project:ro \
  -e NEO4J_PASSWORD=secret \
  ghcr.io/bitkaio/codesteward-mcp:latest
```

## Connecting AI tools to the Docker server

For tools that connect via HTTP/SSE rather than stdio, point them at the
server URL instead of using the `uvx` command:

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

This works for Claude Code, Cursor, Cline, Windsurf, Gemini CLI, VS Code,
and Claude Desktop.
