"""Neo4j graph backend implementation."""

import json
from typing import Any

import structlog
from codesteward.engine.backends.base import GraphBackend

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
        WHERE ($filter = ''
               OR src.name CONTAINS $filter
               OR src.file CONTAINS $filter
               OR tgt.name CONTAINS $filter
               OR r.target_name CONTAINS $filter)
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


class Neo4jBackend(GraphBackend):
    """Neo4j graph backend using the official async driver.

    Args:
        uri: Neo4j bolt URI.
        user: Neo4j username.
        password: Neo4j password.
    """

    def __init__(self, uri: str = "", user: str = "", password: str = "") -> None:
        self._driver: Any | None = None
        if password:
            try:
                import neo4j

                self._driver = neo4j.AsyncGraphDatabase.driver(uri, auth=(user, password))
            except Exception as exc:
                log.error("neo4j_driver_init_failed", error=str(exc))

    def is_connected(self) -> bool:
        return self._driver is not None

    async def close(self) -> None:
        if self._driver is not None:
            await self._driver.close()

    async def write_nodes(self, nodes: list[dict[str, Any]]) -> int:
        if not self._driver or not nodes:
            return 0
        cypher = """
        UNWIND $nodes AS n
        MERGE (node:LexicalNode {node_id: n.node_id})
        SET node += n
        """
        async with self._driver.session() as session:
            await session.run(cypher, nodes=nodes)
        return len(nodes)

    async def write_edges(self, edges_by_type: dict[str, list[dict[str, Any]]]) -> int:
        if not self._driver or not edges_by_type:
            return 0
        total = 0
        async with self._driver.session() as session:
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
                await session.run(cypher, edges=typed_edges)
                total += len(typed_edges)
        return total

    async def delete_file_nodes(self, tenant_id: str, repo_id: str, file_path: str) -> None:
        if not self._driver:
            return
        cypher = """
        MATCH (n:LexicalNode {tenant_id: $tenant_id, repo_id: $repo_id, file: $file})
        DETACH DELETE n
        """
        async with self._driver.session() as session:
            await session.run(cypher, tenant_id=tenant_id, repo_id=repo_id, file=file_path)

    async def delete_repo_data(self, tenant_id: str, repo_id: str) -> None:
        if not self._driver:
            return
        cypher = """
        MATCH (n:LexicalNode {tenant_id: $tenant_id, repo_id: $repo_id})
        DETACH DELETE n
        """
        async with self._driver.session() as session:
            await session.run(cypher, tenant_id=tenant_id, repo_id=repo_id)

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
        if not self._driver:
            return []
        async with self._driver.session() as session:
            result = await session.run(
                template,
                tenant_id=tenant_id,
                repo_id=repo_id,
                filter=filter_str,
                limit=limit,
            )
            return [dict(record) for record in await result.data()]

    async def query_raw(
        self,
        query: str,
        params: dict[str, Any],
    ) -> list[dict[str, Any]]:
        if not self._driver:
            return []
        async with self._driver.session() as session:
            result = await session.run(query, **params)
            return [dict(record) for record in await result.data()]

    async def count_nodes(self, tenant_id: str, repo_id: str) -> int | None:
        if not self._driver:
            return None
        try:
            async with self._driver.session() as session:
                result = await session.run(
                    """
                    MATCH (n:LexicalNode {tenant_id: $tenant_id, repo_id: $repo_id})
                    RETURN count(n) AS node_count
                    """,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                )
                record = await result.single()
                return record["node_count"] if record else None
        except Exception:
            return None

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
        if not self._driver:
            return
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
        async with self._driver.session() as session:
            await session.run(
                cypher,
                source_id=source_id,
                target_id=target_id,
                target_name=target_name,
                tenant_id=tenant_id,
                repo_id=repo_id,
                edge_id=edge_id,
                file=file,
                line=line,
                confidence=confidence,
                source=source,
                rationale=rationale,
            )

    @property
    def backend_name(self) -> str:
        return "neo4j"

    @property
    def raw_query_language(self) -> str:
        return "cypher"


def serialize_node_props(node: Any) -> dict[str, Any]:
    """Convert a LexicalNode to a dict suitable for Neo4j MERGE.

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
    """Convert a GraphEdge to a dict suitable for Neo4j MERGE.

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
