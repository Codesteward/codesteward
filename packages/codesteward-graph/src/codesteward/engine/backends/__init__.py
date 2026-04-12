"""Graph database backend abstraction.

Provides a unified interface for graph storage backends (Neo4j, JanusGraph,
GraphQLite) so that the rest of the codebase is backend-agnostic.
"""

from typing import Any

from codesteward.engine.backends.base import GraphBackend
from codesteward.engine.backends.neo4j import Neo4jBackend

__all__ = ["GraphBackend", "Neo4jBackend", "get_backend"]


def get_backend(backend_type: str, **kwargs: Any) -> GraphBackend:
    """Factory for graph backends.

    Args:
        backend_type: One of ``"neo4j"``, ``"janusgraph"``, or ``"graphqlite"``.
        **kwargs: Backend-specific connection parameters.

    Returns:
        Configured GraphBackend instance.

    Raises:
        ValueError: If ``backend_type`` is not recognised.
    """
    match backend_type:
        case "neo4j":
            return Neo4jBackend(**kwargs)
        case "janusgraph":
            from codesteward.engine.backends.janusgraph import JanusGraphBackend

            return JanusGraphBackend(**kwargs)
        case "graphqlite":
            from codesteward.engine.backends.graphqlite import GraphQLiteBackend

            return GraphQLiteBackend(**kwargs)
        case _:
            raise ValueError(
                f"Unknown graph backend {backend_type!r}; "
                f"valid: 'neo4j', 'janusgraph', 'graphqlite'"
            )

    raise AssertionError("unreachable")  # pragma: no cover
