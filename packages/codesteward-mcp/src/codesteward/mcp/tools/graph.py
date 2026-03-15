"""MCP tool implementations for codebase graph operations.

Four tools are exposed:

``graph_rebuild``
    Parse a repository (or a set of changed files) and write the structural
    graph to Neo4j.  Works in stub mode (parse-only, no Neo4j) when Neo4j
    credentials are not configured.

``codebase_graph_query``
    Query the graph via named templates (lexical / referential / semantic /
    dependency) or raw Cypher passthrough.  Returns YAML.

``graph_augment``
    Add agent-inferred relationships (confidence < 1.0) to the graph.
    Deterministic edges (confidence = 1.0) can only be written by the parser.

``graph_status``
    Return metadata about the current graph: node/edge counts, last build
    timestamp, Neo4j connectivity.
"""


import time
from pathlib import Path
from typing import Any

import structlog
import yaml

from codesteward.engine.graph_builder import GraphBuilder
from codesteward.mcp.config import McpConfig

log = structlog.get_logger()

# ---------------------------------------------------------------------------
# Cypher templates for named query types
# ---------------------------------------------------------------------------

_CYPHER_TEMPLATES: dict[str, str] = {
    "lexical": """
        MATCH (n:LexicalNode {tenant_id: $tenant_id, repo_id: $repo_id})
        WHERE ($filter = '' OR n.name CONTAINS $filter OR n.file CONTAINS $filter)
        RETURN n.node_type AS type, n.name AS name, n.file AS file,
               n.line_start AS line_start, n.line_end AS line_end,
               n.language AS language, n.is_async AS is_async
        ORDER BY n.file, n.line_start
        LIMIT $limit
    """,
    "referential": """
        MATCH (src:LexicalNode {tenant_id: $tenant_id, repo_id: $repo_id})
              -[r:CALLS|IMPORTS|EXTENDS|GUARDED_BY|PROTECTED_BY]->(tgt)
        WHERE ($filter = '' OR src.name CONTAINS $filter OR src.file CONTAINS $filter)
        RETURN src.name AS from_name, src.file AS from_file,
               type(r) AS edge_type,
               tgt.name AS to_name, tgt.file AS to_file,
               r.line AS line
        ORDER BY src.file, r.line
        LIMIT $limit
    """,
    "semantic": """
        MATCH (src:LexicalNode {tenant_id: $tenant_id, repo_id: $repo_id})
              -[r:DATA_FLOW]->(tgt)
        WHERE ($filter = '' OR src.name CONTAINS $filter OR src.file CONTAINS $filter)
        RETURN src.name AS function_name, src.file AS file,
               r.line AS line, tgt.name AS flow_description
        ORDER BY src.file, r.line
        LIMIT $limit
    """,
    "dependency": """
        MATCH (src:LexicalNode {tenant_id: $tenant_id, repo_id: $repo_id,
                                node_type: 'file'})
              -[r:DEPENDS_ON]->(pkg:LexicalNode)
        WHERE ($filter = '' OR pkg.name CONTAINS $filter)
        RETURN DISTINCT pkg.name AS package, pkg.node_type AS type,
               src.file AS referenced_from
        ORDER BY pkg.name
        LIMIT $limit
    """,
}

_ALLOWED_EDGE_TYPES = frozenset({
    "calls", "guarded_by", "protected_by", "data_flow",
    "type_equivalent", "migration_target", "audit_sink",
    "pii_source", "phi_source", "custom",
})


# ---------------------------------------------------------------------------
# Neo4j driver helpers
# ---------------------------------------------------------------------------

def _make_async_driver(cfg: McpConfig) -> Any | None:
    """Create an async Neo4j driver from config, or None if not configured."""
    if not cfg.neo4j_available:
        return None
    try:
        import neo4j
        return neo4j.AsyncGraphDatabase.driver(
            cfg.neo4j_uri, auth=(cfg.neo4j_user, cfg.neo4j_password)
        )
    except Exception as exc:
        log.error("neo4j_driver_init_failed", error=str(exc))
        return None


# ---------------------------------------------------------------------------
# Tool implementations (called by server.py)
# ---------------------------------------------------------------------------

async def tool_graph_rebuild(
    repo_path: str,
    tenant_id: str,
    repo_id: str,
    changed_files: list[str] | None,
    cfg: McpConfig,
) -> str:
    """Build or incrementally update the codebase graph.

    Args:
        repo_path: Absolute path to the cloned repository on disk.
        tenant_id: Tenant namespace for Neo4j isolation.
        repo_id: Repository identifier — must be stable across rebuilds.
        changed_files: Repo-relative paths to re-parse for incremental mode.
            Pass ``None`` for a full rebuild.
        cfg: Server configuration.

    Returns:
        YAML summary with node/edge counts, duration, and Neo4j status.
    """
    mode = "incremental" if changed_files is not None else "full"
    log.info(
        "graph_rebuild_start",
        repo_path=repo_path,
        tenant_id=tenant_id,
        repo_id=repo_id,
        mode=mode,
    )

    driver = _make_async_driver(cfg)
    t0 = time.monotonic()

    try:
        builder = GraphBuilder(neo4j_driver=driver)
        summary = await builder.build_graph(
            repo_path=repo_path,
            tenant_id=tenant_id,
            repo_id=repo_id,
            incremental_files=changed_files,
        )
    except Exception as exc:
        log.error("graph_rebuild_failed", error=str(exc))
        return yaml.safe_dump(
            {"status": "error", "error": str(exc),
             "repo_id": repo_id, "tenant_id": tenant_id},
            default_flow_style=False,
        )
    finally:
        if driver is not None:
            await driver.close()

    summary["mode"] = mode
    summary["duration_ms"] = round((time.monotonic() - t0) * 1000)
    summary["neo4j_connected"] = driver is not None

    # Persist lightweight metadata to workspace if base dir exists
    workspace = Path(cfg.workspace_base) / tenant_id / repo_id
    try:
        workspace.mkdir(parents=True, exist_ok=True)
        (workspace / "graph_build.yaml").write_text(
            yaml.safe_dump(summary, default_flow_style=False, sort_keys=True),
            encoding="utf-8",
        )
    except Exception as exc:
        log.warning("graph_rebuild_metadata_write_failed", error=str(exc))

    log.info(
        "graph_rebuild_done",
        mode=mode,
        files_parsed=summary.get("files_parsed"),
        nodes=summary.get("nodes", {}).get("total"),
        edges=summary.get("edges", {}).get("total"),
    )
    return yaml.safe_dump(summary, default_flow_style=False, sort_keys=True)


async def tool_codebase_graph_query(
    query_type: str,
    query: str,
    tenant_id: str,
    repo_id: str,
    limit: int,
    cfg: McpConfig,
) -> str:
    """Query the codebase graph and return YAML results.

    Args:
        query_type: One of ``lexical``, ``referential``, ``semantic``,
            ``dependency``, or ``cypher`` (raw passthrough).
        query: Filter substring or raw Cypher statement.
        tenant_id: Tenant namespace.
        repo_id: Repository identifier.
        limit: Maximum rows to return.
        cfg: Server configuration.

    Returns:
        YAML-formatted results with a ``stub`` key when Neo4j is unavailable.
    """
    driver = _make_async_driver(cfg)

    if driver is None:
        return yaml.safe_dump({
            "stub": True,
            "reason": "Neo4j not configured — set NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD",
            "query_type": query_type,
            "filter": query,
            "tenant_id": tenant_id,
            "repo_id": repo_id,
            "total": 0,
            "results": [],
        }, default_flow_style=False)

    # Build Cypher + params
    if query_type == "cypher":
        cypher = query
        params: dict[str, Any] = {
            "tenant_id": tenant_id, "repo_id": repo_id, "limit": limit
        }
    else:
        template = _CYPHER_TEMPLATES.get(query_type)
        if template is None:
            await driver.close()
            return yaml.safe_dump({
                "error": f"unknown query_type '{query_type}'",
                "valid_types": list(_CYPHER_TEMPLATES) + ["cypher"],
            }, default_flow_style=False)
        cypher = template
        params = {
            "tenant_id": tenant_id, "repo_id": repo_id,
            "filter": query, "limit": limit,
        }

    try:
        async with driver.session() as session:
            result = await session.run(cypher, **params)
            records = [dict(record) for record in await result.data()]

        output: dict[str, Any] = {
            "query_type": query_type,
            "filter": query,
            "tenant_id": tenant_id,
            "repo_id": repo_id,
            "total": len(records),
            "results": records,
        }
        return yaml.safe_dump(output, default_flow_style=False, allow_unicode=True)

    except Exception as exc:
        log.error("codebase_graph_query_failed", query_type=query_type, error=str(exc))
        return yaml.safe_dump(
            {"error": str(exc), "query_type": query_type},
            default_flow_style=False,
        )
    finally:
        await driver.close()


async def tool_graph_augment(
    tenant_id: str,
    repo_id: str,
    agent_id: str,
    additions: list[dict[str, Any]],
    cfg: McpConfig,
) -> str:
    """Add agent-inferred edges to the graph (confidence < 1.0 only).

    Args:
        tenant_id: Tenant namespace.
        repo_id: Repository identifier.
        agent_id: Identifier of the calling agent (used as the ``source`` tag).
        additions: List of edge descriptors, each with:
            ``source_id``, ``edge_type``, ``target_id``, ``target_name``,
            ``confidence`` (0.0 < x ≤ 0.99), and optional ``rationale``.
        cfg: Server configuration.

    Returns:
        YAML summary with written/skipped counts.
    """
    from codesteward.engine.graph_builder import GraphEdge

    driver = _make_async_driver(cfg)
    source_tag = f"agent:{agent_id}"
    written: list[dict] = []
    skipped: list[dict] = []

    for item in additions:
        edge_type = item.get("edge_type", "")
        confidence = float(item.get("confidence", 0.7))
        source_id = item.get("source_id", "")
        target_id = item.get("target_id", "")
        target_name = item.get("target_name", target_id)
        rationale = item.get("rationale", "")
        file_ = item.get("file", "")
        line_ = item.get("line")

        if not source_id or not target_id:
            skipped.append({"item": item, "reason": "source_id and target_id required"})
            continue
        if edge_type not in _ALLOWED_EDGE_TYPES:
            skipped.append({
                "item": item,
                "reason": f"edge_type {edge_type!r} not allowed; valid: {sorted(_ALLOWED_EDGE_TYPES)}",
            })
            continue
        if not 0.0 < confidence < 1.0:
            skipped.append({
                "item": item,
                "reason": "confidence must be in (0.0, 1.0); 1.0 is reserved for the parser",
            })
            continue

        edge = GraphEdge(
            edge_id=GraphEdge.make_id(source_id, edge_type, target_id),
            edge_type=edge_type,
            source_id=source_id,
            target_id=target_id,
            target_name=target_name,
            file=file_,
            line=line_,
            tenant_id=tenant_id,
            repo_id=repo_id,
            confidence=confidence,
            source=source_tag,
        )

        if driver is not None:
            try:
                rel_type = edge_type.upper()
                cypher = f"""
                MATCH (src:LexicalNode {{node_id: $source_id}})
                MERGE (tgt:LexicalNode {{node_id: $target_id}})
                  ON CREATE SET tgt.name = $target_name, tgt.node_type = 'external',
                                tgt.tenant_id = $tenant_id, tgt.repo_id = $repo_id,
                                tgt.confidence = $confidence, tgt.source = $source
                MERGE (src)-[r:{rel_type} {{edge_id: $edge_id}}]->(tgt)
                SET r.file = $file, r.line = $line,
                    r.confidence = $confidence, r.source = $source,
                    r.rationale = $rationale
                """
                async with driver.session() as session:
                    await session.run(
                        cypher,
                        source_id=edge.source_id,
                        target_id=edge.target_id,
                        target_name=edge.target_name,
                        tenant_id=edge.tenant_id,
                        repo_id=edge.repo_id,
                        edge_id=edge.edge_id,
                        file=edge.file or "",
                        line=edge.line,
                        confidence=edge.confidence,
                        source=edge.source,
                        rationale=rationale,
                    )
            except Exception as exc:
                skipped.append({"item": item, "reason": f"neo4j write failed: {exc}"})
                continue

        written.append({
            "edge_id": edge.edge_id,
            "edge_type": edge_type,
            "source_id": source_id,
            "target_name": target_name,
            "confidence": confidence,
        })

    if driver is not None:
        await driver.close()

    return yaml.safe_dump({
        "status": "ok" if not skipped else "partial",
        "agent_id": agent_id,
        "written": len(written),
        "skipped": len(skipped),
        "edges": written,
        "skip_details": skipped,
        "neo4j_connected": driver is not None,
    }, default_flow_style=False, sort_keys=True)


async def tool_graph_status(
    tenant_id: str,
    repo_id: str,
    cfg: McpConfig,
) -> str:
    """Return metadata about the current graph state.

    Checks Neo4j connectivity, reads workspace build metadata, and returns
    node/edge counts plus last build timestamp.

    Args:
        tenant_id: Tenant namespace.
        repo_id: Repository identifier.
        cfg: Server configuration.

    Returns:
        YAML dict with ``neo4j_connected``, ``last_build``, ``nodes``, ``edges``.
    """
    status: dict[str, Any] = {
        "tenant_id": tenant_id,
        "repo_id": repo_id,
        "neo4j_connected": False,
        "last_build": None,
        "nodes": None,
        "edges": None,
    }

    # Try workspace metadata first (cheap)
    meta_path = Path(cfg.workspace_base) / tenant_id / repo_id / "graph_build.yaml"
    if meta_path.exists():
        try:
            meta = yaml.safe_load(meta_path.read_text()) or {}
            status["last_build"] = meta.get("timestamp") or meta.get("duration_ms")
            status["nodes"] = meta.get("nodes")
            status["edges"] = meta.get("edges")
        except Exception:
            pass

    # Check Neo4j connectivity
    driver = _make_async_driver(cfg)
    if driver is not None:
        try:
            async with driver.session() as session:
                result = await session.run(
                    """
                    MATCH (n:LexicalNode {tenant_id: $tenant_id, repo_id: $repo_id})
                    RETURN count(n) AS node_count
                    """,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                )
                record = await result.single()
                if record:
                    status["nodes"] = {"total": record["node_count"]}
            status["neo4j_connected"] = True
        except Exception as exc:
            status["neo4j_error"] = str(exc)
        finally:
            await driver.close()

    return yaml.safe_dump(status, default_flow_style=False, sort_keys=True)
