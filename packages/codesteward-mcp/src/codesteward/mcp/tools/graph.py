"""MCP tool implementations for codebase graph operations.

Four tools are exposed:

``graph_rebuild``
    Parse a repository (or a set of changed files) and write the structural
    graph to the configured backend (Neo4j or JanusGraph).  Works in stub
    mode (parse-only) when no backend is configured.

``codebase_graph_query``
    Query the graph via named templates (lexical / referential / semantic /
    dependency) or raw query passthrough (Cypher for Neo4j, Gremlin for
    JanusGraph).  Returns YAML.

``graph_augment``
    Add agent-inferred relationships (confidence < 1.0) to the graph.
    Deterministic edges (confidence = 1.0) can only be written by the parser.

``graph_status``
    Return metadata about the current graph: node/edge counts, last build
    timestamp, backend connectivity.
"""


import time
from pathlib import Path
from typing import Any

import structlog
import yaml
from codesteward.engine.backends import get_backend
from codesteward.engine.backends.base import GraphBackend
from codesteward.engine.graph_builder import GraphBuilder
from codesteward.mcp.config import McpConfig

log = structlog.get_logger()

_ALLOWED_EDGE_TYPES = frozenset({
    "calls", "guarded_by", "protected_by", "taint_flow",
    "type_equivalent", "migration_target", "audit_sink",
    "pii_source", "phi_source", "custom",
})


# ---------------------------------------------------------------------------
# Backend factory
# ---------------------------------------------------------------------------

def _make_backend(cfg: McpConfig) -> GraphBackend | None:
    """Create a graph backend from config, or None if not configured."""
    if cfg.graph_backend == "janusgraph":
        try:
            backend = get_backend("janusgraph", url=cfg.janusgraph_url)
            if not backend.is_connected():
                log.warning("janusgraph_not_connected", url=cfg.janusgraph_url)
                return None
            return backend
        except Exception as exc:
            log.error("janusgraph_backend_init_failed", error=str(exc))
            return None

    if cfg.graph_backend == "graphqlite":
        try:
            backend = get_backend("graphqlite", db_path=cfg.graphqlite_db_path)
            if not backend.is_connected():
                log.warning("graphqlite_not_connected")
                return None
            return backend
        except Exception as exc:
            log.error("graphqlite_backend_init_failed", error=str(exc))
            return None

    # Default: Neo4j
    if not cfg.neo4j_available:
        return None
    try:
        backend = get_backend(
            "neo4j",
            uri=cfg.neo4j_uri,
            user=cfg.neo4j_user,
            password=cfg.neo4j_password,
        )
        if not backend.is_connected():
            log.warning("neo4j_not_connected", uri=cfg.neo4j_uri)
            return None
        return backend
    except Exception as exc:
        log.error("neo4j_backend_init_failed", error=str(exc))
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
        tenant_id: Tenant namespace for graph isolation.
        repo_id: Repository identifier — must be stable across rebuilds.
        changed_files: Repo-relative paths to re-parse for incremental mode.
            Pass ``None`` for a full rebuild.
        cfg: Server configuration.

    Returns:
        YAML summary with node/edge counts, duration, and backend status.
    """
    mode = "incremental" if changed_files is not None else "full"
    log.info(
        "graph_rebuild_start",
        repo_path=repo_path,
        tenant_id=tenant_id,
        repo_id=repo_id,
        mode=mode,
    )

    backend = _make_backend(cfg)
    t0 = time.monotonic()

    try:
        builder = GraphBuilder(backend=backend)
        summary = await builder.build_graph(
            repo_path=repo_path,
            tenant_id=tenant_id,
            repo_id=repo_id,
            incremental_files=changed_files,
        )
    except Exception as exc:
        log.error("graph_rebuild_failed", error=str(exc))
        return str(yaml.safe_dump(
            {"status": "error", "error": str(exc),
             "repo_id": repo_id, "tenant_id": tenant_id},
            default_flow_style=False,
        ))
    finally:
        if backend is not None:
            await backend.close()

    summary["mode"] = mode
    summary["duration_ms"] = round((time.monotonic() - t0) * 1000)
    summary["neo4j_connected"] = backend is not None and cfg.graph_backend == "neo4j"
    summary["graph_backend"] = cfg.graph_backend
    summary["backend_connected"] = backend is not None

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
    return str(yaml.safe_dump(summary, default_flow_style=False, sort_keys=True))


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
            ``dependency``, or the backend's raw query language
            (``cypher`` for Neo4j, ``gremlin`` for JanusGraph).
        query: Filter substring or raw query statement.
        tenant_id: Tenant namespace.
        repo_id: Repository identifier.
        limit: Maximum rows to return.
        cfg: Server configuration.

    Returns:
        YAML-formatted results with a ``stub`` key when no backend is available.
    """
    backend = _make_backend(cfg)
    raw_lang = backend.raw_query_language if backend else "cypher"

    if backend is None:
        return str(yaml.safe_dump({
            "stub": True,
            "reason": (
                "Graph backend not configured — set NEO4J_PASSWORD (for Neo4j), "
                "GRAPH_BACKEND=janusgraph (for JanusGraph), or "
                "GRAPH_BACKEND=graphqlite (for embedded SQLite graph)"
            ),
            "query_type": query_type,
            "filter": query,
            "tenant_id": tenant_id,
            "repo_id": repo_id,
            "total": 0,
            "results": [],
        }, default_flow_style=False))

    try:
        # Raw query passthrough (cypher or gremlin)
        if query_type in ("cypher", "gremlin"):
            if query_type != raw_lang:
                await backend.close()
                return str(yaml.safe_dump({
                    "error": (
                        f"Raw query language mismatch: got '{query_type}' but "
                        f"active backend uses '{raw_lang}'"
                    ),
                    "active_backend": backend.backend_name,
                    "expected_query_type": raw_lang,
                }, default_flow_style=False))

            params: dict[str, Any] = {
                "tenant_id": tenant_id, "repo_id": repo_id, "limit": limit
            }
            records = await backend.query_raw(query, params)
        else:
            # Named query template
            try:
                records = await backend.query_named(
                    query_type=query_type,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                    filter_str=query,
                    limit=limit,
                )
            except ValueError as exc:
                await backend.close()
                return str(yaml.safe_dump({
                    "error": str(exc),
                    "valid_types": ["lexical", "referential", "semantic", "dependency", raw_lang],
                }, default_flow_style=False))

        output: dict[str, Any] = {
            "query_type": query_type,
            "filter": query,
            "tenant_id": tenant_id,
            "repo_id": repo_id,
            "total": len(records),
            "results": records,
        }
        return str(yaml.safe_dump(output, default_flow_style=False, allow_unicode=True))

    except Exception as exc:
        log.error("codebase_graph_query_failed", query_type=query_type, error=str(exc))
        return str(yaml.safe_dump(
            {"error": str(exc), "query_type": query_type},
            default_flow_style=False,
        ))
    finally:
        await backend.close()


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

    backend = _make_backend(cfg)
    source_tag = f"agent:{agent_id}"
    written: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

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

        if backend is not None:
            try:
                await backend.write_augment_edge(
                    edge_type=edge_type,
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
                skipped.append({"item": item, "reason": f"backend write failed: {exc}"})
                continue

        written.append({
            "edge_id": edge.edge_id,
            "edge_type": edge_type,
            "source_id": source_id,
            "target_name": target_name,
            "confidence": confidence,
        })

    if backend is not None:
        await backend.close()

    return str(yaml.safe_dump({
        "status": "ok" if not skipped else "partial",
        "agent_id": agent_id,
        "written": len(written),
        "skipped": len(skipped),
        "edges": written,
        "skip_details": skipped,
        "neo4j_connected": backend is not None and cfg.graph_backend == "neo4j",
        "graph_backend": cfg.graph_backend,
        "backend_connected": backend is not None,
    }, default_flow_style=False, sort_keys=True))


async def tool_graph_status(
    tenant_id: str,
    repo_id: str,
    cfg: McpConfig,
) -> str:
    """Return metadata about the current graph state.

    Checks backend connectivity, reads workspace build metadata, and returns
    node/edge counts plus last build timestamp.

    Args:
        tenant_id: Tenant namespace.
        repo_id: Repository identifier.
        cfg: Server configuration.

    Returns:
        YAML dict with ``backend_connected``, ``last_build``, ``nodes``, ``edges``.
    """
    status: dict[str, Any] = {
        "tenant_id": tenant_id,
        "repo_id": repo_id,
        "graph_backend": cfg.graph_backend,
        "neo4j_connected": False,
        "backend_connected": False,
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

    # Check backend connectivity
    backend = _make_backend(cfg)
    if backend is not None:
        try:
            node_count = await backend.count_nodes(tenant_id, repo_id)
            if node_count is not None:
                status["nodes"] = {"total": node_count}
            status["backend_connected"] = True
            if cfg.graph_backend == "neo4j":
                status["neo4j_connected"] = True
        except Exception as exc:
            status["backend_error"] = str(exc)
        finally:
            await backend.close()

    return str(yaml.safe_dump(status, default_flow_style=False, sort_keys=True))
