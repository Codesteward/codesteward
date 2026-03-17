"""Codesteward MCP Graph Server entry point.

Exposes four tools over Model Context Protocol:

``graph_rebuild``
    Parse a repository and write the structural graph to Neo4j (or stub mode
    without Neo4j).

``codebase_graph_query``
    Query the graph via named templates or raw Cypher.

``graph_augment``
    Add agent-inferred relationships (confidence < 1.0) to the graph.

``graph_status``
    Return metadata about the current graph state.

Transport selection (in priority order):
1. ``--transport`` CLI flag  (``sse``, ``http``, or ``stdio``)
2. ``TRANSPORT`` environment variable
3. Default: ``sse``

SSE transport uses Server-Sent Events, binding on ``HOST:PORT`` from config.
HTTP transport uses Streamable HTTP (MCP 2025-03-26 spec) via uvicorn,
binding on ``HOST:PORT`` from config.  Stdio transport reads from stdin and
writes to stdout — suitable for direct subprocess use by MCP clients.
"""


import argparse
import logging
import shutil
import sys
from typing import Any

import structlog
import uvicorn
from codesteward.mcp.config import load_config
from codesteward.mcp.tools.graph import (
    tool_codebase_graph_query,
    tool_graph_augment,
    tool_graph_rebuild,
    tool_graph_status,
)
from codesteward.mcp.tools.taint import tool_taint_analysis

from mcp.server.fastmcp import FastMCP

log = structlog.get_logger()


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(message)s",
        stream=sys.stderr,
    )
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
    )


_TAINT_BINARY: str | None = shutil.which("codesteward-taint")


def build_mcp_server(config_file: str | None = None) -> tuple[FastMCP, Any]:
    """Construct and return the FastMCP server instance plus loaded config.

    Args:
        config_file: Optional path to a YAML config file.

    Returns:
        Tuple of ``(mcp_server, cfg)``.
    """
    cfg = load_config(config_file)
    _configure_logging(cfg.log_level)

    mcp: FastMCP = FastMCP(
        name="codesteward-graph",
        instructions=(
            "Codesteward graph server — parse source repositories into a structural "
            "code graph and query it for code intelligence.\n\n"
            "TYPICAL WORKFLOW\n"
            "1. Call graph_status to check whether a graph already exists for the "
            "repository.  If neo4j_connected is false or last_build is null, proceed "
            "to step 2.\n"
            "2. Call graph_rebuild.  In the standard Docker setup all arguments "
            "can be omitted — the server already knows where the repository is "
            "mounted.  Pass changed_files for incremental updates after a small "
            "code change, or omit for a full parse.  Wait for it to return.\n"
            "3. Call codebase_graph_query to search the graph.  Choose query_type "
            "based on your goal:\n"
            "   - lexical     → find functions/classes/methods by name or file path\n"
            "   - referential → find call/import/extends relationships (who calls what)\n"
            "   - semantic    → find taint-flow paths (source → sink). Requires "
            "codesteward-taint to have been run first. Returns empty until then.\n"
            "   - dependency  → list external package dependencies\n"
            "   - cypher      → raw Cypher for anything not covered by the above\n"
            "4. Optionally call graph_augment to record relationships you have inferred "
            "that the parser could not detect.  Use node_id values from query results "
            "as source_id and target_id — the format is "
            "{node_type}:{tenant_id}:{repo_id}:{file}:{name}.\n\n"
            "IMPORTANT: graph_rebuild must complete successfully before "
            "codebase_graph_query will return non-empty results.  An empty result "
            "from a query does not mean the code has no symbols — it may mean the "
            "graph has not been built yet."
        ),
    )

    # ── graph_rebuild ────────────────────────────────────────────────────────

    @mcp.tool()
    async def graph_rebuild(
        repo_path: str = "",
        tenant_id: str = "",
        repo_id: str = "",
        changed_files: list[str] | None = None,
    ) -> str:
        """Build or incrementally update the codebase graph.

        Parse the repository and write LexicalNode / edge data to Neo4j.
        Must be called before ``codebase_graph_query`` will return results.

        ``repo_path`` is an absolute path on the **server's** filesystem (not
        the client's).  Omit it to use the server's configured default
        (``/repos/project`` in the Docker setup — the repository mounted via
        the ``REPO_PATH`` environment variable in docker-compose).

        When Neo4j is not configured the parser still runs (stub mode) and
        returns node/edge counts, but nothing is persisted — queries will
        return empty results.

        Full rebuild vs incremental:
        - Omit ``changed_files`` (or pass null) for a full rebuild.  Do this
          on first use or after large refactors.
        - Pass a list of repo-relative file paths (e.g. ``["src/auth.py"]``)
          to re-parse only those files.  Use this after small PRs where only
          a few files changed.

        Args:
            repo_path: Absolute path to the repository on the server's disk.
                Omit to use the server default (``default_repo_path`` config).
            tenant_id: Tenant namespace for Neo4j isolation.
                Defaults to the server's ``default_tenant_id``.
            repo_id: Stable identifier for this repository — must be
                consistent across rebuilds.  Defaults to ``default_repo_id``.
            changed_files: Repo-relative paths to re-parse (incremental mode).
                Omit for a full rebuild.

        Returns:
            YAML summary: mode (full|incremental), files_parsed, nodes (dict
            with total), edges (dict with total), duration_ms, neo4j_connected.
        """
        return str(await tool_graph_rebuild(
            repo_path=repo_path or cfg.default_repo_path,
            tenant_id=tenant_id or cfg.default_tenant_id,
            repo_id=repo_id or cfg.default_repo_id,
            changed_files=changed_files,
            cfg=cfg,
        ))

    # ── codebase_graph_query ─────────────────────────────────────────────────

    @mcp.tool()
    async def codebase_graph_query(
        query_type: str,
        query: str = "",
        tenant_id: str = "",
        repo_id: str = "",
        limit: int = 100,
    ) -> str:
        """Query the codebase graph and return YAML results.

        Choose ``query_type`` based on your goal:

        - ``lexical`` — list symbols (functions, classes, methods) matching a
          name or file filter.  Results: type, name, file, line_start,
          line_end, language, is_async.  Use this to answer "does function X
          exist?", "what functions are in file Y?".
        - ``referential`` — traverse CALLS / IMPORTS / EXTENDS / GUARDED_BY /
          PROTECTED_BY edges.  Results: from_name, from_file, edge_type,
          to_name, to_file, line.  Use this to answer "what does function X
          call?", "what imports module Y?", "is route Z protected by auth?".
        - ``semantic`` — traverse TAINT_FLOW edges (source → sink).  Results:
          source_name, source_file, sink_name, sink_file, cwe, hops, level,
          framework.  Requires ``taint_analysis`` to have run first.
        - ``dependency`` — list external package dependencies per file.
          Results: package, type, referenced_from.
        - ``cypher`` — raw Cypher passthrough.  The ``query`` parameter must
          be a full Cypher statement.  Use ``$tenant_id``, ``$repo_id``, and
          ``$limit`` as parameters.  Use this when the named types do not cover
          your query.

        The ``query`` parameter is a substring filter on name or file path for
        named query types (pass ``""`` for no filter).  For ``cypher`` it is
        the full Cypher statement.

        Args:
            query_type: One of ``lexical``, ``referential``, ``semantic``,
                ``dependency``, or ``cypher``.
            query: Substring filter or raw Cypher statement (see above).
            tenant_id: Tenant namespace.  Defaults to server default.
            repo_id: Repository identifier.  Defaults to server default.
            limit: Maximum rows to return (default 100).

        Returns:
            YAML dict with ``query_type``, ``total``, ``results`` (list of
            row dicts), and ``stub: true`` when Neo4j is not configured.
            Each result row's ``node_id`` field can be used as ``source_id``
            or ``target_id`` in ``graph_augment``.
        """
        return str(await tool_codebase_graph_query(
            query_type=query_type,
            query=query,
            tenant_id=tenant_id or cfg.default_tenant_id,
            repo_id=repo_id or cfg.default_repo_id,
            limit=limit,
            cfg=cfg,
        ))

    # ── graph_augment ────────────────────────────────────────────────────────

    @mcp.tool()
    async def graph_augment(
        agent_id: str,
        additions: list[dict[str, Any]],
        tenant_id: str = "",
        repo_id: str = "",
    ) -> str:
        """Add agent-inferred edges to the graph (confidence < 1.0 only).

        Use this when you have identified a relationship through reasoning that
        the parser could not detect statically — for example, a dynamic call
        resolved at runtime, or a data-flow pattern visible only from reading
        the logic.

        Deterministic parser edges (confidence = 1.0) cannot be written via
        this tool.  Use ``graph_rebuild`` to update those.

        Obtaining node IDs: call ``codebase_graph_query`` first (any query
        type) and read ``node_id`` from the result rows.  The format is
        ``{node_type}:{tenant_id}:{repo_id}:{file}:{name}``, for example
        ``function:acme:payments:src/auth.py:verify_token``.

        Each item in ``additions`` must have:
        - ``source_id``: node_id of the source LexicalNode (from query results)
        - ``edge_type``: one of ``calls``, ``guarded_by``, ``protected_by``,
          ``taint_flow``, ``type_equivalent``, ``migration_target``,
          ``audit_sink``, ``pii_source``, ``phi_source``, ``custom``
        - ``target_id``: node_id of the target node
        - ``target_name``: human-readable name for the target
        - ``confidence``: float strictly between 0.0 and 1.0
        - ``rationale`` (optional): brief explanation for the inferred edge

        Args:
            agent_id: Identifier of the calling agent (used as source tag).
            additions: List of edge descriptor dicts (see above).
            tenant_id: Tenant namespace.  Defaults to server default.
            repo_id: Repository identifier.  Defaults to server default.

        Returns:
            YAML summary: status (ok|partial), written count, skipped count,
            edges list, skip_details (explains why each item was rejected).
        """
        return str(await tool_graph_augment(
            tenant_id=tenant_id or cfg.default_tenant_id,
            repo_id=repo_id or cfg.default_repo_id,
            agent_id=agent_id,
            additions=additions,
            cfg=cfg,
        ))

    # ── graph_status ─────────────────────────────────────────────────────────

    @mcp.tool()
    async def graph_status(
        tenant_id: str = "",
        repo_id: str = "",
    ) -> str:
        """Return metadata about the current graph state.

        Call this first before querying.  If ``last_build`` is null or
        ``neo4j_connected`` is false, call ``graph_rebuild`` before attempting
        ``codebase_graph_query``.

        This call is cheap — it reads a local workspace YAML file and does at
        most one lightweight Neo4j count query.

        Args:
            tenant_id: Tenant namespace.  Defaults to server default.
            repo_id: Repository identifier.  Defaults to server default.

        Returns:
            YAML dict with keys: ``neo4j_connected`` (bool), ``last_build``
            (ISO timestamp or null), ``nodes`` (dict with ``total`` count or
            null), ``edges`` (dict with ``total`` count or null).
        """
        return str(await tool_graph_status(
            tenant_id=tenant_id or cfg.default_tenant_id,
            repo_id=repo_id or cfg.default_repo_id,
            cfg=cfg,
        ))

    # ── taint_analysis (optional — only when codesteward-taint is on PATH) ──

    if _TAINT_BINARY is not None:
        _taint_binary: str = _TAINT_BINARY  # narrow str | None → str for the closure

        @mcp.tool()
        async def taint_analysis(
            tenant_id: str = "",
            repo_id: str = "",
            repo_path: str = "",
            frameworks: list[str] | None = None,
            max_hops: int = 8,
            persist_cfg: bool = False,
        ) -> str:
            """Run taint-flow analysis and write TAINT_FLOW edges to Neo4j.

            Traces how untrusted input (HTTP parameters, request bodies, form
            fields) propagates through the call graph to dangerous operations
            (SQL execution, shell commands, file I/O, outbound HTTP). Flags
            paths where no sanitizer is present.

            Requires ``graph_rebuild`` to have completed first. After this tool
            returns, ``codebase_graph_query`` with ``query_type="semantic"`` will
            return taint findings.

            Args:
                tenant_id: Tenant namespace. Defaults to server default.
                repo_id: Repository identifier. Defaults to server default.
                repo_path: Absolute path to the repository on disk. Used by
                    the taint engine to read source files for Level 2 and 3
                    analysis. Defaults to server default.
                frameworks: Catalog names to activate, e.g. ``["fastapi",
                    "express"]``. Omit to auto-detect from languages in graph.
                max_hops: Maximum CALLS depth for Level 1 traversal (default 8).
                persist_cfg: Write BasicBlock nodes and CFG_EDGE relationships
                    to Neo4j (enables path-level Cypher queries). Default false.

            Returns:
                YAML with paths_unsafe, paths_sanitized, findings list (each
                with source_name, source_file, sink_name, sink_file, cwe,
                hops, level), and duration_ms. TAINT_FLOW edges are written
                to Neo4j so subsequent semantic queries return results.
            """
            return str(await tool_taint_analysis(
                tenant_id=tenant_id or cfg.default_tenant_id,
                repo_id=repo_id or cfg.default_repo_id,
                repo_path=repo_path or cfg.default_repo_path,
                frameworks=frameworks,
                max_hops=max_hops,
                persist_cfg=persist_cfg,
                cfg=cfg,
                binary=_taint_binary,
            ))

        log.info("taint_analysis_tool_registered", binary=_TAINT_BINARY)

    return mcp, cfg


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="codesteward-mcp",
        description="Codesteward MCP Graph Server",
    )
    parser.add_argument(
        "--transport",
        choices=["sse", "http", "stdio"],
        default=None,
        help="MCP transport (overrides TRANSPORT env var and config)",
    )
    parser.add_argument(
        "--config",
        metavar="FILE",
        default=None,
        help="Path to a YAML config file (overrides MCP_CONFIG_FILE env var)",
    )
    parser.add_argument(
        "--host",
        default=None,
        help="HTTP bind host (overrides config)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="HTTP bind port (overrides config)",
    )
    return parser.parse_args()


def main() -> None:
    """CLI entry point — called by ``codesteward-mcp`` console script."""
    args = _parse_args()
    mcp, cfg = build_mcp_server(config_file=args.config)

    # Resolve transport: CLI flag > env var > config field > default
    import os

    transport = args.transport or os.getenv("TRANSPORT") or cfg.transport

    host = args.host or cfg.host
    port = args.port or cfg.port

    log.info(
        "codesteward_mcp_starting",
        transport=transport,
        host=host if transport in ("http", "sse") else "n/a",
        port=port if transport in ("http", "sse") else "n/a",
    )

    if transport == "stdio":
        # Stdio: synchronous run on the current thread
        mcp.run(transport="stdio")
    elif transport == "sse":
        # SSE: Server-Sent Events transport via uvicorn
        uvicorn.run(
            mcp.sse_app(),
            host=host,
            port=port,
            log_level=cfg.log_level.lower(),
        )
    else:
        # HTTP: Streamable HTTP via uvicorn
        app = mcp.streamable_http_app()
        uvicorn.run(
            app,
            host=host,
            port=port,
            log_level=cfg.log_level.lower(),
        )


if __name__ == "__main__":
    main()
