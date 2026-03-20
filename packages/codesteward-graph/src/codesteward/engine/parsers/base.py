"""Base data models and abstract parser interface for the Codesteward graph builder.

All concrete parsers share these data structures:
  - LexicalNode   — a symbol (file, function, class, variable, expression)
  - GraphEdge     — a directed relationship between two nodes
  - ParseResult   — the output of parsing one source file
  - LanguageParser — abstract base class every language parser implements
"""


import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import structlog

log = structlog.get_logger()


# ===========================================================================
# Data model — nodes and edges stored in / returned from Neo4j
# ===========================================================================


@dataclass
class LexicalNode:
    """A single node in the lexical graph layer.

    Attributes:
        node_id: Globally unique ID (deterministic hash of tenant+repo+file+name+type).
        node_type: "file" | "function" | "class" | "variable".
        name: Identifier name (e.g. "handleLogin", "UserService").
        file: Repo-relative file path.
        line_start: First line of the definition.
        line_end: Last line of the definition (None for variables/imports).
        language: Source language ("typescript" | "javascript").
        tenant_id: Tenant namespace for Neo4j graph isolation.
        repo_id: Repository identifier.
        exported: Whether this symbol is exported.
        is_async: Whether this is an async function.
    """

    node_id: str
    node_type: str  # file | function | class | variable | expression
    name: str
    file: str
    line_start: int
    line_end: int | None = None
    language: str = "typescript"
    tenant_id: str = ""
    repo_id: str = ""
    exported: bool = False
    is_async: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    @staticmethod
    def make_id(tenant_id: str, repo_id: str, file: str, name: str, node_type: str) -> str:
        """Generate a deterministic node ID from its key fields.

        Args:
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            file: File path relative to repo root.
            name: Symbol name.
            node_type: Node type string.

        Returns:
            8-character hex string prefixed by type (e.g. "fn:a1b2c3d4").
        """
        raw = f"{tenant_id}:{repo_id}:{file}:{name}:{node_type}"
        digest = hashlib.sha1(raw.encode()).hexdigest()[:12]
        prefix = {"function": "fn", "class": "cls", "variable": "var", "file": "f"}.get(
            node_type, "n"
        )
        return f"{prefix}:{digest}"


@dataclass
class GraphEdge:
    """A directed edge between two graph nodes.

    Attributes:
        edge_id: Deterministic ID.
        edge_type: "imports" | "exports" | "calls" | "extends" |
                   "implements" | "depends_on" | "guarded_by" | "taint_flow".
        source_id: ID of the source node.
        target_id: ID of the target node (or target name for unresolved).
        target_name: Human-readable target name (for unresolved cross-file refs).
        file: File where this edge was detected.
        line: Line number of the edge.
        tenant_id: Tenant namespace.
        repo_id: Repository identifier.
        confidence: Certainty score in (0.0, 1.0]; 1.0 reserved for parser-emitted edges.
        source: Tag identifying what wrote this edge (e.g. "agent:<id>").
    """

    edge_id: str
    edge_type: str
    source_id: str
    target_id: str
    target_name: str = ""
    file: str = ""
    line: int | None = None
    tenant_id: str = ""
    repo_id: str = ""
    confidence: float = 1.0
    source: str = ""

    @staticmethod
    def make_id(source_id: str, edge_type: str, target_id: str) -> str:
        """Generate a deterministic edge ID.

        Args:
            source_id: Source node ID.
            edge_type: Edge type string.
            target_id: Target node ID or name.

        Returns:
            12-character hex digest.
        """
        raw = f"{source_id}:{edge_type}:{target_id}"
        return hashlib.sha1(raw.encode()).hexdigest()[:12]


@dataclass
class ParseResult:
    """Output of parsing a single file.

    Attributes:
        file_node: The LexicalNode representing the file itself.
        nodes: All symbol nodes extracted from the file.
        edges: All edges extracted from the file (referential + semantic).
    """

    file_node: LexicalNode
    nodes: list[LexicalNode] = field(default_factory=list)
    edges: list[GraphEdge] = field(default_factory=list)

    @property
    def all_nodes(self) -> list[LexicalNode]:
        """File node plus all symbol nodes."""
        return [self.file_node, *self.nodes]


# ===========================================================================
# Abstract language parser interface
# ===========================================================================


class LanguageParser(ABC):
    """Abstract base for all language parsers.

    Concrete parsers implement this interface. GraphBuilder depends only
    on this ABC. All parsers use tree-sitter ASTs; COBOL is the only
    exception (regex-based, no tree-sitter grammar available).
    """

    @abstractmethod
    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> ParseResult:
        """Parse a single source file and return its graph representation.

        Args:
            file_path: Repo-relative path to the file (used as node identifier).
            content: Full file content as a string.
            tenant_id: Tenant namespace for node ID generation.
            repo_id: Repository identifier for node ID generation.
            language: Source language string (e.g. "typescript", "python").

        Returns:
            ParseResult with the file node, all symbol nodes, and all edges.
        """
        ...
