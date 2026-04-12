"""Tests for MCP graph tool implementations."""


from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import yaml
from codesteward.mcp.config import McpConfig
from codesteward.mcp.tools.graph import (
    tool_codebase_graph_query,
    tool_graph_augment,
    tool_graph_rebuild,
    tool_graph_status,
)

# ---------------------------------------------------------------------------
# graph_rebuild
# ---------------------------------------------------------------------------


class TestToolGraphRebuild:
    async def test_stub_mode_no_neo4j(self, cfg: McpConfig, tmp_path: Path) -> None:
        """Full rebuild in stub mode (no Neo4j) returns YAML summary."""
        cfg = McpConfig(  # type: ignore[call-arg]
            graph_backend="neo4j",
            neo4j_password="",
            workspace_base=str(tmp_path),
            default_tenant_id="t1",
            default_repo_id="r1",
        )

        # Write a minimal Python file so the parser has something to chew on
        (tmp_path / "hello.py").write_text("def greet(): pass\n")

        mock_summary = {
            "files_parsed": 1,
            "nodes": {"total": 1},
            "edges": {"total": 0},
            "timestamp": "2026-01-01T00:00:00",
        }

        with patch(
            "codesteward.mcp.tools.graph.GraphBuilder"
        ) as MockBuilder:
            instance = MockBuilder.return_value
            instance.build_graph = AsyncMock(return_value=mock_summary)

            result = await tool_graph_rebuild(
                repo_path=str(tmp_path),
                tenant_id="t1",
                repo_id="r1",
                changed_files=None,
                cfg=cfg,
            )

        data = yaml.safe_load(result)
        assert data["mode"] == "full"
        assert data["backend_connected"] is False
        assert "duration_ms" in data

    async def test_incremental_mode(self, cfg: McpConfig, tmp_path: Path) -> None:
        """changed_files triggers incremental mode."""
        cfg = McpConfig(  # type: ignore[call-arg]
            neo4j_password="",
            workspace_base=str(tmp_path),
            default_tenant_id="t1",
            default_repo_id="r1",
        )

        mock_summary: dict[str, Any] = {"files_parsed": 1, "nodes": {"total": 2}, "edges": {"total": 1}}

        with patch("codesteward.mcp.tools.graph.GraphBuilder") as MockBuilder:
            instance = MockBuilder.return_value
            instance.build_graph = AsyncMock(return_value=mock_summary)

            result = await tool_graph_rebuild(
                repo_path=str(tmp_path),
                tenant_id="t1",
                repo_id="r1",
                changed_files=["src/foo.py"],
                cfg=cfg,
            )

        data = yaml.safe_load(result)
        assert data["mode"] == "incremental"

    async def test_error_returns_yaml_error(self, cfg: McpConfig, tmp_path: Path) -> None:
        """When GraphBuilder raises, the tool returns a YAML error dict."""
        cfg = McpConfig(  # type: ignore[call-arg]
            neo4j_password="",
            workspace_base=str(tmp_path),
            default_tenant_id="t1",
            default_repo_id="r1",
        )

        with patch("codesteward.mcp.tools.graph.GraphBuilder") as MockBuilder:
            instance = MockBuilder.return_value
            instance.build_graph = AsyncMock(side_effect=RuntimeError("parser boom"))

            result = await tool_graph_rebuild(
                repo_path="/nonexistent",
                tenant_id="t1",
                repo_id="r1",
                changed_files=None,
                cfg=cfg,
            )

        data = yaml.safe_load(result)
        assert data["status"] == "error"
        assert "parser boom" in data["error"]


# ---------------------------------------------------------------------------
# codebase_graph_query
# ---------------------------------------------------------------------------


def _mock_neo4j_backend(records: list[dict[str, Any]] | None = None) -> MagicMock:
    """Create a mock Neo4j backend for testing."""
    backend = MagicMock()
    backend.is_connected.return_value = True
    backend.backend_name = "neo4j"
    backend.raw_query_language = "cypher"
    backend.close = AsyncMock()
    backend.query_named = AsyncMock(return_value=records or [])
    backend.query_raw = AsyncMock(return_value=records or [])
    backend.count_nodes = AsyncMock(return_value=0)
    return backend


def _mock_janusgraph_backend(records: list[dict[str, Any]] | None = None) -> MagicMock:
    """Create a mock JanusGraph backend for testing."""
    backend = MagicMock()
    backend.is_connected.return_value = True
    backend.backend_name = "janusgraph"
    backend.raw_query_language = "gremlin"
    backend.close = AsyncMock()
    backend.query_named = AsyncMock(return_value=records or [])
    backend.query_raw = AsyncMock(return_value=records or [])
    backend.count_nodes = AsyncMock(return_value=0)
    return backend


class TestToolCodebaseGraphQuery:
    async def test_stub_when_no_neo4j(self, cfg: McpConfig) -> None:
        """Returns stub response when no backend is configured."""
        result = await tool_codebase_graph_query(
            query_type="lexical",
            query="",
            tenant_id="t1",
            repo_id="r1",
            limit=10,
            cfg=cfg,
        )
        data = yaml.safe_load(result)
        assert data["stub"] is True
        assert data["total"] == 0
        assert data["results"] == []

    async def test_unknown_query_type_returns_error(self, cfg_with_neo4j: McpConfig) -> None:
        """Unknown query_type returns an error dict (no crash)."""
        backend = _mock_neo4j_backend()
        backend.query_named = AsyncMock(
            side_effect=ValueError("unknown query_type 'invalid_type'")
        )

        with patch("codesteward.mcp.tools.graph._make_backend", return_value=backend):
            result = await tool_codebase_graph_query(
                query_type="invalid_type",
                query="",
                tenant_id="t1",
                repo_id="r1",
                limit=10,
                cfg=cfg_with_neo4j,
            )

        data = yaml.safe_load(result)
        assert "error" in data
        assert "invalid_type" in data["error"]

    async def test_lexical_query_returns_results(self, cfg_with_neo4j: McpConfig) -> None:
        """Lexical query runs the template and returns rows."""
        mock_records = [
            {"type": "function", "name": "my_func", "file": "app.py",
             "line_start": 10, "line_end": 20, "language": "python", "is_async": False}
        ]

        backend = _mock_neo4j_backend(records=mock_records)

        with patch("codesteward.mcp.tools.graph._make_backend", return_value=backend):
            result = await tool_codebase_graph_query(
                query_type="lexical",
                query="my_func",
                tenant_id="t1",
                repo_id="r1",
                limit=50,
                cfg=cfg_with_neo4j,
            )

        data = yaml.safe_load(result)
        assert data["total"] == 1
        assert data["results"][0]["name"] == "my_func"

    async def test_raw_cypher_on_neo4j(self, cfg_with_neo4j: McpConfig) -> None:
        """Raw Cypher passthrough works on Neo4j backend."""
        backend = _mock_neo4j_backend(records=[{"count": 42}])

        with patch("codesteward.mcp.tools.graph._make_backend", return_value=backend):
            result = await tool_codebase_graph_query(
                query_type="cypher",
                query="MATCH (n) RETURN count(n) AS count",
                tenant_id="t1",
                repo_id="r1",
                limit=10,
                cfg=cfg_with_neo4j,
            )

        data = yaml.safe_load(result)
        assert data["total"] == 1
        backend.query_raw.assert_called_once()

    async def test_raw_gremlin_rejected_on_neo4j(self, cfg_with_neo4j: McpConfig) -> None:
        """Gremlin query type is rejected when Neo4j backend is active."""
        backend = _mock_neo4j_backend()

        with patch("codesteward.mcp.tools.graph._make_backend", return_value=backend):
            result = await tool_codebase_graph_query(
                query_type="gremlin",
                query="g.V().count()",
                tenant_id="t1",
                repo_id="r1",
                limit=10,
                cfg=cfg_with_neo4j,
            )

        data = yaml.safe_load(result)
        assert "error" in data
        assert "mismatch" in data["error"]


# ---------------------------------------------------------------------------
# codebase_graph_query — JanusGraph backend
# ---------------------------------------------------------------------------


class TestToolCodebaseGraphQueryJanusGraph:
    async def test_lexical_query_on_janusgraph(
        self, cfg_with_janusgraph: McpConfig
    ) -> None:
        """Lexical query works on JanusGraph backend."""
        mock_records = [
            {"type": "function", "name": "handler", "file": "routes.go",
             "line_start": 5, "line_end": 15, "language": "go", "is_async": False}
        ]
        backend = _mock_janusgraph_backend(records=mock_records)

        with patch("codesteward.mcp.tools.graph._make_backend", return_value=backend):
            result = await tool_codebase_graph_query(
                query_type="lexical",
                query="handler",
                tenant_id="t1",
                repo_id="r1",
                limit=50,
                cfg=cfg_with_janusgraph,
            )

        data = yaml.safe_load(result)
        assert data["total"] == 1
        assert data["results"][0]["name"] == "handler"
        backend.query_named.assert_called_once_with(
            query_type="lexical",
            tenant_id="t1",
            repo_id="r1",
            filter_str="handler",
            limit=50,
        )

    async def test_raw_gremlin_on_janusgraph(
        self, cfg_with_janusgraph: McpConfig
    ) -> None:
        """Raw Gremlin passthrough works on JanusGraph backend."""
        backend = _mock_janusgraph_backend(records=[{"result": 42}])

        with patch("codesteward.mcp.tools.graph._make_backend", return_value=backend):
            result = await tool_codebase_graph_query(
                query_type="gremlin",
                query="g.V().count()",
                tenant_id="t1",
                repo_id="r1",
                limit=10,
                cfg=cfg_with_janusgraph,
            )

        data = yaml.safe_load(result)
        assert data["total"] == 1
        backend.query_raw.assert_called_once()

    async def test_raw_cypher_rejected_on_janusgraph(
        self, cfg_with_janusgraph: McpConfig
    ) -> None:
        """Cypher query type is rejected when JanusGraph backend is active."""
        backend = _mock_janusgraph_backend()

        with patch("codesteward.mcp.tools.graph._make_backend", return_value=backend):
            result = await tool_codebase_graph_query(
                query_type="cypher",
                query="MATCH (n) RETURN n",
                tenant_id="t1",
                repo_id="r1",
                limit=10,
                cfg=cfg_with_janusgraph,
            )

        data = yaml.safe_load(result)
        assert "error" in data
        assert "mismatch" in data["error"]

    async def test_referential_query_on_janusgraph(
        self, cfg_with_janusgraph: McpConfig
    ) -> None:
        """Referential query works on JanusGraph backend."""
        mock_records = [
            {"from_name": "main", "from_file": "app.py", "edge_type": "CALLS",
             "to_name": "helper", "to_file": "utils.py", "to_node_type": "function",
             "line": 10}
        ]
        backend = _mock_janusgraph_backend(records=mock_records)

        with patch("codesteward.mcp.tools.graph._make_backend", return_value=backend):
            result = await tool_codebase_graph_query(
                query_type="referential",
                query="main",
                tenant_id="t1",
                repo_id="r1",
                limit=50,
                cfg=cfg_with_janusgraph,
            )

        data = yaml.safe_load(result)
        assert data["total"] == 1
        assert data["results"][0]["edge_type"] == "CALLS"


# ---------------------------------------------------------------------------
# graph_augment
# ---------------------------------------------------------------------------


class TestToolGraphAugment:
    async def test_stub_mode_writes_without_neo4j(self, cfg: McpConfig) -> None:
        """In stub mode (no backend) valid edges are accepted and returned."""
        result = await tool_graph_augment(
            tenant_id="t1",
            repo_id="r1",
            agent_id="security-agent",
            additions=[
                {
                    "source_id": "fn:t1:r1:app.py:get_user",
                    "edge_type": "calls",
                    "target_id": "fn:t1:r1:db.py:query",
                    "target_name": "query",
                    "confidence": 0.85,
                    "rationale": "inferred from usage pattern",
                }
            ],
            cfg=cfg,
        )

        data = yaml.safe_load(result)
        assert data["written"] == 1
        assert data["skipped"] == 0
        assert data["edges"][0]["confidence"] == pytest.approx(0.85)

    async def test_confidence_1_is_rejected(self, cfg: McpConfig) -> None:
        """confidence = 1.0 is reserved for the parser and must be rejected."""
        result = await tool_graph_augment(
            tenant_id="t1",
            repo_id="r1",
            agent_id="test-agent",
            additions=[
                {
                    "source_id": "fn:t1:r1:app.py:foo",
                    "edge_type": "calls",
                    "target_id": "fn:t1:r1:db.py:bar",
                    "target_name": "bar",
                    "confidence": 1.0,
                }
            ],
            cfg=cfg,
        )

        data = yaml.safe_load(result)
        assert data["written"] == 0
        assert data["skipped"] == 1
        assert "confidence" in data["skip_details"][0]["reason"]

    async def test_invalid_edge_type_is_rejected(self, cfg: McpConfig) -> None:
        """Unknown edge_type must be rejected."""
        result = await tool_graph_augment(
            tenant_id="t1",
            repo_id="r1",
            agent_id="test-agent",
            additions=[
                {
                    "source_id": "fn:t1:r1:app.py:foo",
                    "edge_type": "invented_edge",
                    "target_id": "fn:t1:r1:db.py:bar",
                    "target_name": "bar",
                    "confidence": 0.7,
                }
            ],
            cfg=cfg,
        )

        data = yaml.safe_load(result)
        assert data["written"] == 0
        assert data["skipped"] == 1

    async def test_missing_source_id_rejected(self, cfg: McpConfig) -> None:
        """Item without source_id must be skipped."""
        result = await tool_graph_augment(
            tenant_id="t1",
            repo_id="r1",
            agent_id="test-agent",
            additions=[
                {
                    "edge_type": "calls",
                    "target_id": "fn:t1:r1:db.py:bar",
                    "target_name": "bar",
                    "confidence": 0.7,
                }
            ],
            cfg=cfg,
        )

        data = yaml.safe_load(result)
        assert data["skipped"] == 1

    async def test_partial_status_on_mixed_input(self, cfg: McpConfig) -> None:
        """Mix of valid and invalid items → status='partial'."""
        result = await tool_graph_augment(
            tenant_id="t1",
            repo_id="r1",
            agent_id="test-agent",
            additions=[
                {
                    "source_id": "fn:t1:r1:app.py:foo",
                    "edge_type": "calls",
                    "target_id": "fn:t1:r1:db.py:bar",
                    "target_name": "bar",
                    "confidence": 0.7,
                },
                {
                    "edge_type": "calls",  # missing source_id
                    "target_id": "fn:t1:r1:db.py:baz",
                    "target_name": "baz",
                    "confidence": 0.5,
                },
            ],
            cfg=cfg,
        )

        data = yaml.safe_load(result)
        assert data["status"] == "partial"
        assert data["written"] == 1
        assert data["skipped"] == 1

    async def test_augment_with_janusgraph_backend(
        self, cfg_with_janusgraph: McpConfig
    ) -> None:
        """graph_augment works with JanusGraph backend."""
        backend = _mock_janusgraph_backend()
        backend.write_augment_edge = AsyncMock()

        with patch("codesteward.mcp.tools.graph._make_backend", return_value=backend):
            result = await tool_graph_augment(
                tenant_id="t1",
                repo_id="r1",
                agent_id="security-agent",
                additions=[
                    {
                        "source_id": "fn:t1:r1:app.go:handler",
                        "edge_type": "calls",
                        "target_id": "fn:t1:r1:db.go:query",
                        "target_name": "query",
                        "confidence": 0.9,
                    }
                ],
                cfg=cfg_with_janusgraph,
            )

        data = yaml.safe_load(result)
        assert data["written"] == 1
        assert data["graph_backend"] == "janusgraph"
        backend.write_augment_edge.assert_called_once()


# ---------------------------------------------------------------------------
# graph_status
# ---------------------------------------------------------------------------


class TestToolGraphStatus:
    async def test_stub_mode_no_neo4j(self, cfg: McpConfig, tmp_path: Path) -> None:
        """Returns status with backend_connected=False when no backend."""
        cfg = McpConfig(  # type: ignore[call-arg]
            graph_backend="neo4j",
            neo4j_password="",
            workspace_base=str(tmp_path),
            default_tenant_id="t1",
            default_repo_id="r1",
        )

        result = await tool_graph_status(tenant_id="t1", repo_id="r1", cfg=cfg)
        data = yaml.safe_load(result)

        assert data["backend_connected"] is False
        assert data["tenant_id"] == "t1"
        assert data["repo_id"] == "r1"

    async def test_reads_workspace_metadata(self, cfg: McpConfig, tmp_path: Path) -> None:
        """Reads last_build / node count from workspace graph_build.yaml."""
        cfg = McpConfig(  # type: ignore[call-arg]
            graph_backend="neo4j",
            neo4j_password="",
            workspace_base=str(tmp_path),
            default_tenant_id="t1",
            default_repo_id="r1",
        )

        ws = tmp_path / "t1" / "r1"
        ws.mkdir(parents=True)
        (ws / "graph_build.yaml").write_text(
            yaml.safe_dump(
                {
                    "timestamp": "2026-01-01T12:00:00",
                    "nodes": {"total": 42},
                    "edges": {"total": 10},
                }
            )
        )

        result = await tool_graph_status(tenant_id="t1", repo_id="r1", cfg=cfg)
        data = yaml.safe_load(result)

        assert data["last_build"] == "2026-01-01T12:00:00"
        assert data["nodes"]["total"] == 42

    async def test_status_with_janusgraph_backend(
        self, cfg_with_janusgraph: McpConfig, tmp_path: Path
    ) -> None:
        """graph_status works with JanusGraph backend."""
        cfg_with_janusgraph.workspace_base = str(tmp_path)
        backend = _mock_janusgraph_backend()
        backend.count_nodes = AsyncMock(return_value=100)

        with patch("codesteward.mcp.tools.graph._make_backend", return_value=backend):
            result = await tool_graph_status(
                tenant_id="t1", repo_id="r1", cfg=cfg_with_janusgraph
            )

        data = yaml.safe_load(result)
        assert data["backend_connected"] is True
        assert data["graph_backend"] == "janusgraph"
        assert data["nodes"]["total"] == 100
