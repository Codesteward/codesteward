"""JanusGraph graph backend implementation via Gremlin (Apache TinkerPop).

Uses the ``gremlinpython`` driver to communicate with JanusGraph Server
over WebSocket. All queries are expressed in Gremlin traversal language.

JanusGraph property graph mapping:
  - LexicalNode  → vertex with label ``LexicalNode``
  - Edge types   → edge labels (``CALLS``, ``IMPORTS``, ``GUARDED_BY``, …)
  - Properties   → vertex/edge properties matching the Neo4j schema
"""

from typing import Any

import structlog

from codesteward.engine.backends.base import GraphBackend

log = structlog.get_logger()


class JanusGraphBackend(GraphBackend):
    """JanusGraph backend using gremlinpython.

    Args:
        url: Gremlin Server WebSocket URL (e.g. ``ws://localhost:8182/gremlin``).
    """

    def __init__(self, url: str = "ws://localhost:8182/gremlin") -> None:
        self._url = url
        self._connection: Any | None = None
        self._g: Any | None = None
        try:
            from gremlin_python.driver.driver_remote_connection import (
                DriverRemoteConnection,
            )
            from gremlin_python.process.anonymous_traversal import traversal

            self._connection = DriverRemoteConnection(url, "g")
            self._g = traversal().with_remote(self._connection)
            log.info("janusgraph_connected", url=url)
        except Exception as exc:
            log.error("janusgraph_connection_failed", url=url, error=str(exc))
            self._connection = None
            self._g = None

    def is_connected(self) -> bool:
        return self._g is not None

    async def close(self) -> None:
        if self._connection is not None:
            try:
                self._connection.close()
            except Exception:
                pass

    # ── Write operations ─────────────────────────────────────────────────

    async def write_nodes(self, nodes: list[dict[str, Any]]) -> int:
        if not self._g or not nodes:
            return 0

        from gremlin_python.process.graph_traversal import __
        from gremlin_python.process.traversal import T

        g = self._g
        for node in nodes:
            t = g.V().has("LexicalNode", "node_id", node["node_id"]).fold().coalesce(
                __.unfold(),
                __.addV("LexicalNode").property("node_id", node["node_id"]),
            )
            for key, val in node.items():
                if key != "node_id" and val is not None:
                    t = t.property(key, val)
            t.iterate()

        return len(nodes)

    async def write_edges(self, edges_by_type: dict[str, list[dict[str, Any]]]) -> int:
        if not self._g or not edges_by_type:
            return 0

        from gremlin_python.process.graph_traversal import __

        g = self._g
        total = 0
        for rel_type, typed_edges in edges_by_type.items():
            for edge in typed_edges:
                # Ensure target vertex exists
                g.V().has("LexicalNode", "node_id", edge["target_id"]).fold().coalesce(
                    __.unfold(),
                    __.addV("LexicalNode")
                    .property("node_id", edge["target_id"])
                    .property("name", edge.get("target_name", ""))
                    .property("node_type", "external")
                    .property("tenant_id", edge.get("tenant_id", ""))
                    .property("repo_id", edge.get("repo_id", "")),
                ).iterate()

                # Upsert edge
                g.V().has("LexicalNode", "node_id", edge["source_id"]).as_("src") \
                    .V().has("LexicalNode", "node_id", edge["target_id"]).as_("tgt") \
                    .coalesce(
                        __.select("src").outE(rel_type).where(
                            __.has("edge_id", edge["edge_id"])
                        ),
                        __.select("src").addE(rel_type).to(__.select("tgt"))
                        .property("edge_id", edge["edge_id"]),
                    ) \
                    .property("file", edge.get("file", "")) \
                    .property("line", edge.get("line")) \
                    .iterate()

                total += 1

        return total

    async def delete_file_nodes(self, tenant_id: str, repo_id: str, file_path: str) -> None:
        if not self._g:
            return
        self._g.V().has("LexicalNode", "tenant_id", tenant_id) \
            .has("repo_id", repo_id) \
            .has("file", file_path) \
            .drop().iterate()

    # ── Query operations ─────────────────────────────────────────────────

    async def query_named(
        self,
        query_type: str,
        tenant_id: str,
        repo_id: str,
        filter_str: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        if not self._g:
            return []

        match query_type:
            case "lexical":
                return self._query_lexical(tenant_id, repo_id, filter_str, limit)
            case "referential":
                return self._query_referential(tenant_id, repo_id, filter_str, limit)
            case "semantic":
                return self._query_semantic(tenant_id, repo_id, filter_str, limit)
            case "dependency":
                return self._query_dependency(tenant_id, repo_id, filter_str, limit)
            case _:
                raise ValueError(
                    f"unknown query_type '{query_type}'; "
                    f"valid: lexical, referential, semantic, dependency, {self.raw_query_language}"
                )

    def _query_lexical(
        self, tenant_id: str, repo_id: str, filter_str: str, limit: int
    ) -> list[dict[str, Any]]:
        from gremlin_python.process.graph_traversal import __
        from gremlin_python.process.traversal import TextP

        g = self._g
        t = g.V().has_label("LexicalNode") \
            .has("tenant_id", tenant_id) \
            .has("repo_id", repo_id)

        if filter_str:
            t = t.or_(
                __.has("name", TextP.containing(filter_str)),
                __.has("file", TextP.containing(filter_str)),
            )

        t = t.order().by("file").by("line_start")
        results = t.limit(limit).project(
            "type", "name", "file", "line_start", "line_end", "language", "is_async"
        ).by(__.values("node_type")) \
            .by(__.values("name")) \
            .by(__.values("file")) \
            .by(__.coalesce(__.values("line_start"), __.constant(None))) \
            .by(__.coalesce(__.values("line_end"), __.constant(None))) \
            .by(__.coalesce(__.values("language"), __.constant(None))) \
            .by(__.coalesce(__.values("is_async"), __.constant(False))) \
            .toList()

        return results

    def _query_referential(
        self, tenant_id: str, repo_id: str, filter_str: str, limit: int
    ) -> list[dict[str, Any]]:
        from gremlin_python.process.graph_traversal import __
        from gremlin_python.process.traversal import TextP

        g = self._g
        edge_labels = ["CALLS", "IMPORTS", "EXTENDS", "GUARDED_BY", "PROTECTED_BY"]

        t = g.V().has_label("LexicalNode") \
            .has("tenant_id", tenant_id) \
            .has("repo_id", repo_id)

        if filter_str:
            t = t.or_(
                __.has("name", TextP.containing(filter_str)),
                __.has("file", TextP.containing(filter_str)),
            )

        results = t.outE(*edge_labels).as_("e") \
            .inV().as_("tgt") \
            .select("e").outV().as_("src") \
            .select("src", "e", "tgt") \
            .project(
                "from_name", "from_file", "edge_type",
                "to_name", "to_file", "to_node_type", "line"
            ) \
            .by(__.select("src").values("name")) \
            .by(__.select("src").values("file")) \
            .by(__.select("e").label()) \
            .by(__.select("tgt").values("name")) \
            .by(__.select("tgt").coalesce(__.values("file"), __.constant(""))) \
            .by(__.select("tgt").coalesce(__.values("node_type"), __.constant("external"))) \
            .by(__.select("e").coalesce(__.values("line"), __.constant(None))) \
            .limit(limit) \
            .toList()

        return results

    def _query_semantic(
        self, tenant_id: str, repo_id: str, filter_str: str, limit: int
    ) -> list[dict[str, Any]]:
        from gremlin_python.process.graph_traversal import __
        from gremlin_python.process.traversal import TextP

        g = self._g
        t = g.V().has_label("LexicalNode") \
            .has("tenant_id", tenant_id) \
            .has("repo_id", repo_id)

        if filter_str:
            t = t.or_(
                __.has("name", TextP.containing(filter_str)),
                __.has("file", TextP.containing(filter_str)),
            )

        results = t.outE("TAINT_FLOW") \
            .has("sanitized", False).as_("e") \
            .inV().as_("tgt") \
            .select("e").outV().as_("src") \
            .select("src", "e", "tgt") \
            .project(
                "source_name", "source_file", "sink_name", "sink_file",
                "cwe", "hops", "level", "framework"
            ) \
            .by(__.select("src").values("name")) \
            .by(__.select("src").values("file")) \
            .by(__.select("tgt").values("name")) \
            .by(__.select("tgt").values("file")) \
            .by(__.select("e").coalesce(__.values("cwe"), __.constant(None))) \
            .by(__.select("e").coalesce(__.values("hops"), __.constant(None))) \
            .by(__.select("e").coalesce(__.values("level"), __.constant(None))) \
            .by(__.select("e").coalesce(__.values("framework"), __.constant(None))) \
            .order().by(__.select("e").values("hops")) \
            .limit(limit) \
            .toList()

        return results

    def _query_dependency(
        self, tenant_id: str, repo_id: str, filter_str: str, limit: int
    ) -> list[dict[str, Any]]:
        from gremlin_python.process.graph_traversal import __
        from gremlin_python.process.traversal import TextP

        g = self._g
        t = g.V().has_label("LexicalNode") \
            .has("tenant_id", tenant_id) \
            .has("repo_id", repo_id) \
            .has("node_type", "file")

        results = t.outE("DEPENDS_ON").inV().as_("pkg") \
            .select("pkg")

        if filter_str:
            results = results.has("name", TextP.containing(filter_str))

        results = results.path().by(__.values("file")).by(__.label()).by(
            __.project("package", "type").by(__.values("name")).by(
                __.coalesce(__.values("node_type"), __.constant("external"))
            )
        ).limit(limit).toList()

        # Flatten path results
        rows: list[dict[str, Any]] = []
        for path in results:
            objects = path.objects if hasattr(path, "objects") else path
            if len(objects) >= 3:
                pkg_info = objects[2]
                rows.append({
                    "package": pkg_info.get("package", ""),
                    "type": pkg_info.get("type", "external"),
                    "referenced_from": objects[0],
                })

        return rows

    async def query_raw(
        self,
        query: str,
        params: dict[str, Any],
    ) -> list[dict[str, Any]]:
        if not self._g:
            return []

        from gremlin_python.driver.client import Client

        client = Client(self._url, "g")
        try:
            result_set = client.submit(query, params)
            results = result_set.all().result()
            # Normalise Gremlin results to list of dicts
            rows: list[dict[str, Any]] = []
            for item in results:
                if isinstance(item, dict):
                    rows.append(item)
                else:
                    rows.append({"result": item})
            return rows
        finally:
            client.close()

    async def count_nodes(self, tenant_id: str, repo_id: str) -> int | None:
        if not self._g:
            return None
        try:
            result = self._g.V().has_label("LexicalNode") \
                .has("tenant_id", tenant_id) \
                .has("repo_id", repo_id) \
                .count().next()
            return result
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
        if not self._g:
            return

        from gremlin_python.process.graph_traversal import __

        g = self._g
        rel_type = edge_type.upper()

        # Ensure target vertex exists
        g.V().has("LexicalNode", "node_id", target_id).fold().coalesce(
            __.unfold(),
            __.addV("LexicalNode")
            .property("node_id", target_id)
            .property("name", target_name)
            .property("node_type", "external")
            .property("tenant_id", tenant_id)
            .property("repo_id", repo_id)
            .property("confidence", confidence)
            .property("source", source),
        ).iterate()

        # Upsert edge
        t = g.V().has("LexicalNode", "node_id", source_id).as_("src") \
            .V().has("LexicalNode", "node_id", target_id).as_("tgt") \
            .coalesce(
                __.select("src").outE(rel_type).where(
                    __.has("edge_id", edge_id)
                ),
                __.select("src").addE(rel_type).to(__.select("tgt"))
                .property("edge_id", edge_id),
            ) \
            .property("file", file) \
            .property("line", line) \
            .property("confidence", confidence) \
            .property("source", source) \
            .property("rationale", rationale)
        t.iterate()

    @property
    def backend_name(self) -> str:
        return "janusgraph"

    @property
    def raw_query_language(self) -> str:
        return "gremlin"
