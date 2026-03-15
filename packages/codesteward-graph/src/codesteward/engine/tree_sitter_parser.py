"""Backward-compatibility shim.

The actual tree-sitter implementations have been moved to the per-language
modules in ``codesteward.engine.parsers``.  This module re-exports the
``TreeSitterParser`` and ``is_available`` names that existing code expects.

Usage (unchanged from before the refactor)::

    from codesteward.engine.tree_sitter_parser import TreeSitterParser, is_available

    if is_available("typescript"):
        parser = TreeSitterParser()
        result = parser.parse("src/auth.ts", content, "acme", "payments", "typescript")
"""


from codesteward.engine.parsers._ast_utils import is_available  # noqa: F401
from codesteward.engine.parsers.base import GraphEdge, LexicalNode, ParseResult  # noqa: F401


class TreeSitterParser:
    """Backward-compat wrapper. Delegates to per-language AST parsers via the registry."""

    def __init__(self) -> None:
        """Initialise internal AST parsers for each language."""
        from codesteward.engine.parsers.java import JavaParser
        from codesteward.engine.parsers.python import PythonParser
        from codesteward.engine.parsers.typescript import TypeScriptParser

        self._ts = TypeScriptParser() if is_available("typescript") else None
        self._py = PythonParser() if is_available("python") else None
        self._java = JavaParser() if is_available("java") else None

    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "typescript",
    ) -> ParseResult:
        """Parse using the appropriate language AST parser.

        Args:
            file_path: Repo-relative path to the file.
            content: Full file content as a string.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Source language string.

        Returns:
            ParseResult with the file node, symbol nodes, and edges.
        """
        from codesteward.engine.parsers import get_parser  # noqa: PLC0415

        parser = get_parser(language)
        return parser.parse(file_path, content, tenant_id, repo_id, language)
