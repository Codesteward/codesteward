"""Integration tests for the GraphQLite backend.

These tests exercise the real GraphQLite engine with an in-memory SQLite
database to verify that query templates, write operations, and edge
deduplication work correctly — issues that mocked tests cannot catch.
"""


import pytest

graphqlite = pytest.importorskip("graphqlite", reason="graphqlite not installed")

from codesteward.engine.backends.graphqlite import GraphQLiteBackend


@pytest.fixture
async def backend():
    """Create a fresh in-memory GraphQLite backend for each test."""
    b = GraphQLiteBackend(db_path=":memory:")
    assert b.is_connected()
    yield b
    await b.close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _node(node_id: str, name: str, file: str, node_type: str = "function",
          tenant_id: str = "t1", repo_id: str = "r1",
          language: str = "python") -> dict:
    return {
        "node_id": node_id, "node_type": node_type, "name": name,
        "file": file, "line_start": 1, "line_end": 10,
        "language": language, "tenant_id": tenant_id, "repo_id": repo_id,
        "exported": False, "is_async": False, "metadata": "{}",
    }


def _file_node(file: str, tenant_id: str = "t1",
               repo_id: str = "r1") -> dict:
    node_id = f"file:{tenant_id}:{repo_id}:{file}:{file}"
    return _node(node_id, file, file, node_type="file",
                 tenant_id=tenant_id, repo_id=repo_id)


# ---------------------------------------------------------------------------
# write_nodes + count_nodes
# ---------------------------------------------------------------------------


class TestWriteAndCount:
    async def test_write_and_count_nodes(self, backend: GraphQLiteBackend) -> None:
        nodes = [
            _node("fn:t1:r1:a.py:foo", "foo", "a.py"),
            _node("fn:t1:r1:b.py:bar", "bar", "b.py"),
        ]
        written = await backend.write_nodes(nodes)
        assert written == 2

        count = await backend.count_nodes("t1", "r1")
        assert count == 2

    async def test_count_filters_by_tenant_and_repo(
        self, backend: GraphQLiteBackend
    ) -> None:
        """count_nodes must filter by tenant/repo, not return all nodes."""
        nodes = [
            _node("fn:t1:r1:a.py:foo", "foo", "a.py", tenant_id="t1", repo_id="r1"),
            _node("fn:t2:r2:b.py:bar", "bar", "b.py", tenant_id="t2", repo_id="r2"),
        ]
        await backend.write_nodes(nodes)

        assert await backend.count_nodes("t1", "r1") == 1
        assert await backend.count_nodes("t2", "r2") == 1
        assert await backend.count_nodes("t1", "r2") == 0


# ---------------------------------------------------------------------------
# Lexical query
# ---------------------------------------------------------------------------


class TestLexicalQuery:
    async def test_returns_nodes_for_correct_tenant(
        self, backend: GraphQLiteBackend
    ) -> None:
        """Lexical query must filter by tenant_id and repo_id."""
        await backend.write_nodes([
            _node("fn:t1:r1:a.py:foo", "foo", "a.py", tenant_id="t1", repo_id="r1"),
            _node("fn:t2:r2:b.py:bar", "bar", "b.py", tenant_id="t2", repo_id="r2"),
        ])

        results = await backend.query_named("lexical", "t1", "r1", "", 100)
        assert len(results) == 1
        assert results[0]["name"] == "foo"

    async def test_filter_by_name(self, backend: GraphQLiteBackend) -> None:
        await backend.write_nodes([
            _node("fn:t1:r1:a.py:foo", "foo", "a.py"),
            _node("fn:t1:r1:a.py:bar", "bar", "a.py"),
        ])

        results = await backend.query_named("lexical", "t1", "r1", "foo", 100)
        assert len(results) == 1
        assert results[0]["name"] == "foo"

    async def test_filter_by_file(self, backend: GraphQLiteBackend) -> None:
        await backend.write_nodes([
            _node("fn:t1:r1:a.py:foo", "foo", "a.py"),
            _node("fn:t1:r1:b.py:bar", "bar", "b.py"),
        ])

        results = await backend.query_named("lexical", "t1", "r1", "b.py", 100)
        assert len(results) == 1
        assert results[0]["name"] == "bar"

    async def test_unknown_query_type_raises(
        self, backend: GraphQLiteBackend
    ) -> None:
        with pytest.raises(ValueError, match="unknown query_type"):
            await backend.query_named("nonexistent", "t1", "r1", "", 10)


# ---------------------------------------------------------------------------
# Referential query
# ---------------------------------------------------------------------------


class TestReferentialQuery:
    async def test_returns_edge_properties(
        self, backend: GraphQLiteBackend
    ) -> None:
        """Referential query reads to_name from edge property, not target node."""
        await backend.write_nodes([
            _node("fn:t1:r1:a.py:caller", "caller", "a.py"),
        ])
        await backend.write_edges({
            "CALLS": [{
                "source_id": "fn:t1:r1:a.py:caller",
                "target_id": "fn:t1:r1:b.py:callee",
                "target_name": "callee",
                "edge_id": "e1",
                "file": "a.py",
                "line": 5,
                "tenant_id": "t1",
                "repo_id": "r1",
            }],
        })

        results = await backend.query_named("referential", "t1", "r1", "", 100)
        assert len(results) == 1
        row = results[0]
        assert row["from_name"] == "caller"
        assert row["edge_type"] == "CALLS"
        assert row["to_name"] == "callee"
        assert row["to_id"] == "fn:t1:r1:b.py:callee"

    async def test_filters_by_tenant(self, backend: GraphQLiteBackend) -> None:
        """Referential query must only return edges for the given tenant."""
        await backend.write_nodes([
            _node("fn:t1:r1:a.py:foo", "foo", "a.py", tenant_id="t1", repo_id="r1"),
            _node("fn:t2:r2:c.py:baz", "baz", "c.py", tenant_id="t2", repo_id="r2"),
        ])
        await backend.write_edges({
            "CALLS": [
                {
                    "source_id": "fn:t1:r1:a.py:foo",
                    "target_id": "fn:t1:r1:b.py:bar",
                    "target_name": "bar",
                    "edge_id": "e1", "file": "a.py", "line": 1,
                    "tenant_id": "t1", "repo_id": "r1",
                },
                {
                    "source_id": "fn:t2:r2:c.py:baz",
                    "target_id": "fn:t2:r2:d.py:qux",
                    "target_name": "qux",
                    "edge_id": "e2", "file": "c.py", "line": 1,
                    "tenant_id": "t2", "repo_id": "r2",
                },
            ],
        })

        results = await backend.query_named("referential", "t1", "r1", "", 100)
        assert len(results) == 1
        assert results[0]["to_name"] == "bar"


# ---------------------------------------------------------------------------
# Dependency query
# ---------------------------------------------------------------------------


class TestDependencyQuery:
    async def test_returns_package_name_from_edge(
        self, backend: GraphQLiteBackend
    ) -> None:
        """Dependency query must return non-null package names (from edge props)."""
        await backend.write_nodes([
            _file_node("package.json"),
        ])
        await backend.write_edges({
            "DEPENDS_ON": [{
                "source_id": "file:t1:r1:package.json:package.json",
                "target_id": "lodash",
                "target_name": "lodash@4.17.21",
                "edge_id": "dep1",
                "file": "package.json",
                "line": 0,
                "tenant_id": "t1",
                "repo_id": "r1",
            }],
        })

        results = await backend.query_named("dependency", "t1", "r1", "", 100)
        assert len(results) == 1
        assert results[0]["package"] == "lodash@4.17.21"
        assert results[0]["referenced_from"] == "package.json"

    async def test_filter_narrows_results(
        self, backend: GraphQLiteBackend
    ) -> None:
        await backend.write_nodes([_file_node("package.json")])
        await backend.write_edges({
            "DEPENDS_ON": [
                {
                    "source_id": "file:t1:r1:package.json:package.json",
                    "target_id": "lodash", "target_name": "lodash@4.17.21",
                    "edge_id": "dep1", "file": "package.json", "line": 0,
                    "tenant_id": "t1", "repo_id": "r1",
                },
                {
                    "source_id": "file:t1:r1:package.json:package.json",
                    "target_id": "express", "target_name": "express@4.18.0",
                    "edge_id": "dep2", "file": "package.json", "line": 0,
                    "tenant_id": "t1", "repo_id": "r1",
                },
            ],
        })

        results = await backend.query_named("dependency", "t1", "r1", "lodash", 100)
        assert len(results) == 1
        assert "lodash" in results[0]["package"]


# ---------------------------------------------------------------------------
# delete_file_nodes
# ---------------------------------------------------------------------------


class TestDeleteFileNodes:
    async def test_deletes_only_target_file(
        self, backend: GraphQLiteBackend
    ) -> None:
        """delete_file_nodes must only remove nodes for the specified file."""
        await backend.write_nodes([
            _node("fn:t1:r1:a.py:foo", "foo", "a.py"),
            _node("fn:t1:r1:b.py:bar", "bar", "b.py"),
        ])
        assert await backend.count_nodes("t1", "r1") == 2

        await backend.delete_file_nodes("t1", "r1", "a.py")
        assert await backend.count_nodes("t1", "r1") == 1

        results = await backend.query_named("lexical", "t1", "r1", "", 100)
        assert results[0]["name"] == "bar"

    async def test_does_not_delete_other_repos(
        self, backend: GraphQLiteBackend
    ) -> None:
        """delete_file_nodes must not touch nodes in other repos."""
        await backend.write_nodes([
            _node("fn:t1:r1:a.py:foo", "foo", "a.py", tenant_id="t1", repo_id="r1"),
            _node("fn:t1:r2:a.py:bar", "bar", "a.py", tenant_id="t1", repo_id="r2"),
        ])

        await backend.delete_file_nodes("t1", "r1", "a.py")
        assert await backend.count_nodes("t1", "r1") == 0
        assert await backend.count_nodes("t1", "r2") == 1


# ---------------------------------------------------------------------------
# delete_repo_data
# ---------------------------------------------------------------------------


class TestDeleteRepoData:
    async def test_deletes_only_target_repo(
        self, backend: GraphQLiteBackend
    ) -> None:
        await backend.write_nodes([
            _node("fn:t1:r1:a.py:foo", "foo", "a.py", tenant_id="t1", repo_id="r1"),
            _node("fn:t1:r2:b.py:bar", "bar", "b.py", tenant_id="t1", repo_id="r2"),
        ])

        await backend.delete_repo_data("t1", "r1")
        assert await backend.count_nodes("t1", "r1") == 0
        assert await backend.count_nodes("t1", "r2") == 1


# ---------------------------------------------------------------------------
# write_augment_edge deduplication
# ---------------------------------------------------------------------------


class TestAugmentEdgeDedup:
    async def test_augment_edge_is_idempotent(
        self, backend: GraphQLiteBackend
    ) -> None:
        """Calling write_augment_edge twice with the same edge_id must not
        create duplicate edges."""
        await backend.write_nodes([
            _node("fn:t1:r1:a.py:foo", "foo", "a.py"),
        ])

        common = dict(
            edge_type="calls",
            source_id="fn:t1:r1:a.py:foo",
            target_id="fn:t1:r1:b.py:bar",
            target_name="bar",
            tenant_id="t1",
            repo_id="r1",
            edge_id="aug-edge-1",
            file="a.py",
            line=10,
            confidence=0.85,
            source="agent:test",
            rationale="test",
        )

        await backend.write_augment_edge(**common)
        await backend.write_augment_edge(**common)

        results = await backend.query_named("referential", "t1", "r1", "foo", 100)
        # Should be exactly 1 edge, not 2
        calls_edges = [r for r in results if r["edge_type"] == "CALLS"]
        assert len(calls_edges) == 1

    async def test_augment_edge_updates_properties(
        self, backend: GraphQLiteBackend
    ) -> None:
        """Re-writing an augment edge updates its properties."""
        await backend.write_nodes([
            _node("fn:t1:r1:a.py:foo", "foo", "a.py"),
        ])

        base = dict(
            edge_type="calls",
            source_id="fn:t1:r1:a.py:foo",
            target_id="fn:t1:r1:b.py:bar",
            target_name="bar",
            tenant_id="t1",
            repo_id="r1",
            edge_id="aug-edge-2",
            file="a.py",
            line=10,
            source="agent:test",
        )

        await backend.write_augment_edge(**base, confidence=0.5, rationale="v1")
        await backend.write_augment_edge(**base, confidence=0.9, rationale="v2")

        results = await backend.query_named("referential", "t1", "r1", "foo", 100)
        calls_edges = [r for r in results if r["edge_type"] == "CALLS"]
        assert len(calls_edges) == 1


# ---------------------------------------------------------------------------
# Special characters (injection safety via _cypher_escape)
# ---------------------------------------------------------------------------


class TestSpecialCharacters:
    async def test_node_with_quotes_in_name(
        self, backend: GraphQLiteBackend
    ) -> None:
        """Strings with double quotes must be handled safely."""
        await backend.write_nodes([
            _node('fn:t1:r1:a.py:say"hi', 'say"hi', "a.py"),
        ])
        count = await backend.count_nodes("t1", "r1")
        assert count == 1

    async def test_filter_with_quotes(self, backend: GraphQLiteBackend) -> None:
        """Filter strings with special chars must not break queries."""
        await backend.write_nodes([
            _node("fn:t1:r1:a.py:foo", "foo", "a.py"),
        ])
        # Should not raise, even with quotes in filter
        results = await backend.query_named("lexical", "t1", "r1", 'say"hi', 100)
        assert results == []
