"""Abstract base class for graph database backends."""

from abc import ABC, abstractmethod
from typing import Any


class GraphBackend(ABC):
    """Unified interface for graph storage backends.

    Implementations must handle connection lifecycle, node/edge writes,
    queries, and cleanup. All methods are async to support both Neo4j
    (native async) and JanusGraph (HTTP/WebSocket to Gremlin Server).
    """

    @abstractmethod
    def is_connected(self) -> bool:
        """Return True if the backend has a live connection configured."""

    @abstractmethod
    async def close(self) -> None:
        """Release backend resources (driver/connection pool)."""

    # ── Write operations ─────────────────────────────────────────────────

    @abstractmethod
    async def write_nodes(self, nodes: list[dict[str, Any]]) -> int:
        """Upsert nodes into the graph.

        Args:
            nodes: List of node property dicts. Each must contain at minimum
                ``node_id``, ``node_type``, ``name``, ``file``, ``tenant_id``,
                ``repo_id``.

        Returns:
            Number of nodes written.
        """

    @abstractmethod
    async def write_edges(self, edges_by_type: dict[str, list[dict[str, Any]]]) -> int:
        """Upsert edges into the graph, grouped by relationship type.

        Args:
            edges_by_type: Mapping of uppercase edge type (e.g. ``"CALLS"``)
                to list of edge property dicts. Each dict must contain
                ``edge_id``, ``source_id``, ``target_id``, ``target_name``,
                ``tenant_id``, ``repo_id``, ``file``, ``line``.

        Returns:
            Total number of edges written.
        """

    @abstractmethod
    async def delete_file_nodes(self, tenant_id: str, repo_id: str, file_path: str) -> None:
        """Delete all nodes and edges scoped to a specific file.

        Args:
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            file_path: Repo-relative path of the file to remove.
        """

    @abstractmethod
    async def delete_repo_data(self, tenant_id: str, repo_id: str) -> None:
        """Delete all nodes and edges for an entire tenant/repo.

        Called before a full rebuild to prevent duplicate edges in backends
        that use CREATE instead of MERGE for edge writes (e.g. GraphQLite).

        Args:
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
        """

    # ── Query operations ─────────────────────────────────────────────────

    @abstractmethod
    async def query_named(
        self,
        query_type: str,
        tenant_id: str,
        repo_id: str,
        filter_str: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        """Execute a named query template.

        Args:
            query_type: One of ``lexical``, ``referential``, ``semantic``,
                ``dependency``.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            filter_str: Substring filter on name/file (empty = no filter).
            limit: Maximum rows to return.

        Returns:
            List of result row dicts.

        Raises:
            ValueError: If ``query_type`` is not recognised.
        """

    @abstractmethod
    async def query_raw(
        self,
        query: str,
        params: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Execute a raw backend-native query.

        For Neo4j this is Cypher; for JanusGraph this is Gremlin.

        Args:
            query: The raw query string.
            params: Query parameters.

        Returns:
            List of result row dicts.
        """

    @abstractmethod
    async def count_nodes(self, tenant_id: str, repo_id: str) -> int | None:
        """Return the total node count for a tenant/repo, or None on error.

        Args:
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            Node count, or None if the query fails.
        """

    # ── Augment (agent-inferred edges) ───────────────────────────────────

    @abstractmethod
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
        """Write a single agent-inferred edge.

        Args:
            edge_type: Relationship type (lowercase, e.g. ``"calls"``).
            source_id: Source node ID.
            target_id: Target node ID.
            target_name: Human-readable target name.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            edge_id: Unique edge identifier.
            file: File path associated with the edge.
            line: Line number, or None.
            confidence: Confidence score (0.0, 1.0).
            source: Source tag (e.g. ``"agent:security-agent"``).
            rationale: Brief explanation for the inferred edge.
        """

    @property
    @abstractmethod
    def backend_name(self) -> str:
        """Return the backend identifier (e.g. ``"neo4j"``, ``"janusgraph"``)."""

    @property
    @abstractmethod
    def raw_query_language(self) -> str:
        """Return the name of the raw query language (e.g. ``"cypher"``, ``"gremlin"``)."""
