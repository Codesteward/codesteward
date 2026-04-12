"""GraphQLite (SQLite-based) graph backend implementation.

Lightweight embedded graph database using the ``graphqlite`` package — a
SQLite extension that supports Cypher queries.  Requires no external server,
no Docker, and no configuration beyond a filesystem path.

Designed for local development and single-user ``uvx`` deployments where
Neo4j or JanusGraph would be overkill.
"""

import asyncio
import json
from pathlib import Path
from typing import Any

import structlog
from codesteward.engine.backends.base import GraphBackend

log = structlog.get_logger()

# ---------------------------------------------------------------------------
# Cypher templates — reused from the Neo4j backend with zero modifications
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
               tgt.node_type AS to_node_type,
               r.line AS line
        ORDER BY src.file, r.line
        LIMIT $limit
    """,
    "semantic": """
        MATCH (src:LexicalNode {tenant_id: $tenant_id, repo_id: $repo_id})
              -[r:TAINT_FLOW]->(tgt:LexicalNode)
        WHERE ($filter = '' OR src.name CONTAINS $filter OR src.file CONTAINS $filter)
          AND NOT r.sanitized
        RETURN src.name AS source_name, src.file AS source_file,
               tgt.name AS sink_name,   tgt.file AS sink_file,
               r.cwe AS cwe, r.hops AS hops,
               r.level AS level, r.framework AS framework
        ORDER BY r.hops ASC, src.file ASC
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


class GraphQLiteBackend(GraphBackend):
    """Embedded SQLite graph backend using GraphQLite's Cypher engine.

    The database is stored as a single ``.db`` file on disk, or ``:memory:``
    for ephemeral use (tests).  All Cypher queries execute synchronously
    inside SQLite and are wrapped with ``asyncio.to_thread`` to satisfy
    the async ``GraphBackend`` interface.

    Args:
        db_path: Path to the SQLite database file.  Defaults to
            ``~/.codesteward/graph.db``.  Use ``:memory:`` for tests.
    """

    def __init__(self, db_path: str = "") -> None:
        self._conn: Any | None = None
        resolved = db_path or str(Path.home() / ".codesteward" / "graph.db")
        try:
            import graphqlite

            if resolved != ":memory:":
                Path(resolved).parent.mkdir(parents=True, exist_ok=True)
            self._conn = graphqlite.connect(resolved)
            log.info("graphqlite_connected", db_path=resolved)
        except Exception as exc:
            log.error("graphqlite_connection_failed", db_path=resolved, error=str(exc))

    def is_connected(self) -> bool:
        return self._conn is not None

    async def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # ── Write operations ─────────────────────────────────────────────────

    async def write_nodes(self, nodes: list[dict[str, Any]]) -> int:
        if not self._conn or not nodes:
            return 0

        def _write() -> int:
            cypher = """
            UNWIND $nodes AS n
            MERGE (node:LexicalNode {node_id: n.node_id})
            SET node += n
            """
            self._conn.cypher(cypher, {"nodes": nodes})
            return len(nodes)

        return await asyncio.to_thread(_write)

    async def write_edges(self, edges_by_type: dict[str, list[dict[str, Any]]]) -> int:
        if not self._conn or not edges_by_type:
            return 0

        def _write() -> int:
            total = 0
            for rel_type, typed_edges in edges_by_type.items():
                cypher = f"""
                UNWIND $edges AS e
                MATCH (src:LexicalNode {{node_id: e.source_id}})
                MERGE (tgt:LexicalNode {{node_id: e.target_id}})
                  ON CREATE SET tgt.name = e.target_name, tgt.node_type = 'external',
                                tgt.tenant_id = e.tenant_id, tgt.repo_id = e.repo_id
                MERGE (src)-[r:{rel_type} {{edge_id: e.edge_id}}]->(tgt)
                SET r.file = e.file, r.line = e.line
                """
                self._conn.cypher(cypher, {"edges": typed_edges})
                total += len(typed_edges)
            return total

        return await asyncio.to_thread(_write)

    async def delete_file_nodes(
        self, tenant_id: str, repo_id: str, file_path: str
    ) -> None:
        if not self._conn:
            return

        def _delete() -> None:
            self._conn.cypher(
                """
                MATCH (n:LexicalNode {tenant_id: $tenant_id, repo_id: $repo_id,
                                      file: $file})
                DETACH DELETE n
                """,
                {"tenant_id": tenant_id, "repo_id": repo_id, "file": file_path},
            )

        await asyncio.to_thread(_delete)

    # ── Query operations ─────────────────────────────────────────────────

    async def query_named(
        self,
        query_type: str,
        tenant_id: str,
        repo_id: str,
        filter_str: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        template = _CYPHER_TEMPLATES.get(query_type)
        if template is None:
            raise ValueError(
                f"unknown query_type '{query_type}'; "
                f"valid: {list(_CYPHER_TEMPLATES) + [self.raw_query_language]}"
            )
        if not self._conn:
            return []

        def _query() -> list[dict[str, Any]]:
            result = self._conn.cypher(
                template,
                {
                    "tenant_id": tenant_id,
                    "repo_id": repo_id,
                    "filter": filter_str,
                    "limit": limit,
                },
            )
            return result.to_list()

        return await asyncio.to_thread(_query)

    async def query_raw(
        self,
        query: str,
        params: dict[str, Any],
    ) -> list[dict[str, Any]]:
        if not self._conn:
            return []

        def _query() -> list[dict[str, Any]]:
            result = self._conn.cypher(query, params if params else None)
            return result.to_list()

        return await asyncio.to_thread(_query)

    async def count_nodes(self, tenant_id: str, repo_id: str) -> int | None:
        if not self._conn:
            return None
        try:

            def _count() -> int | None:
                result = self._conn.cypher(
                    """
                    MATCH (n:LexicalNode {tenant_id: $tenant_id, repo_id: $repo_id})
                    RETURN count(n) AS node_count
                    """,
                    {"tenant_id": tenant_id, "repo_id": repo_id},
                )
                rows = result.to_list()
                return rows[0]["node_count"] if rows else None

            return await asyncio.to_thread(_count)
        except Exception:
            return None

    # ── Augment (agent-inferred edges) ───────────────────────────────────

    async def write_augment_edge(
        self,
        edge_type: str,
        source_id: str,
        target_id: str,
        target_name: str,
        tenant_id: str,
        repo_id: str,
        edge_id: str,
        file: str,
        line: int | None,
        confidence: float,
        source: str,
        rationale: str,
    ) -> None:
        if not self._conn:
            return
        rel_type = edge_type.upper()

        def _write() -> None:
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
            self._conn.cypher(
                cypher,
                {
                    "source_id": source_id,
                    "target_id": target_id,
                    "target_name": target_name,
                    "tenant_id": tenant_id,
                    "repo_id": repo_id,
                    "edge_id": edge_id,
                    "file": file,
                    "line": line,
                    "confidence": confidence,
                    "source": source,
                    "rationale": rationale,
                },
            )

        await asyncio.to_thread(_write)

    @property
    def backend_name(self) -> str:
        return "graphqlite"

    @property
    def raw_query_language(self) -> str:
        return "cypher"


def serialize_node_props(node: Any) -> dict[str, Any]:
    """Convert a LexicalNode to a dict suitable for GraphQLite MERGE.

    Args:
        node: A LexicalNode instance.

    Returns:
        Property dict with JSON-serialized metadata.
    """
    return {
        "node_id": node.node_id,
        "node_type": node.node_type,
        "name": node.name,
        "file": node.file,
        "line_start": node.line_start,
        "line_end": node.line_end,
        "language": node.language,
        "tenant_id": node.tenant_id,
        "repo_id": node.repo_id,
        "exported": node.exported,
        "is_async": node.is_async,
        "metadata": json.dumps(node.metadata) if node.metadata else "{}",
    }


def serialize_edge_props(edge: Any) -> dict[str, Any]:
    """Convert a GraphEdge to a dict suitable for GraphQLite MERGE.

    Args:
        edge: A GraphEdge instance.

    Returns:
        Property dict for edge upsert.
    """
    return {
        "source_id": edge.source_id,
        "target_id": edge.target_id,
        "target_name": edge.target_name,
        "tenant_id": edge.tenant_id,
        "repo_id": edge.repo_id,
        "edge_id": edge.edge_id,
        "file": edge.file,
        "line": edge.line,
    }
