"""C parser (tree-sitter AST). Requires ``tree-sitter-c`` (install with ``uv pip install -e '.[graph-c]'``).
"""

import structlog

from ._ast_utils import TreeSitterBase, _strip_quotes, _walk
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult

log = structlog.get_logger()


def _c_function_name(decl_node: object) -> str | None:
    """Recursively extract the identifier from a C function declarator.

    Handles pointer_declarator wrapping (e.g. ``*fn_name``).

    Args:
        decl_node: A C declarator AST node.

    Returns:
        Function name string, or None if unresolvable.
    """
    if decl_node is None:
        return None
    if decl_node.type == "function_declarator":  # type: ignore[union-attr]
        inner = decl_node.child_by_field_name("declarator")  # type: ignore[union-attr]
        if inner is None:
            return None
        if inner.type in ("identifier", "field_identifier"):
            return inner.text.decode()  # type: ignore[union-attr]
        # Recurse for pointer_declarator wrapping
        return _c_function_name(inner)
    if decl_node.type == "pointer_declarator":  # type: ignore[union-attr]
        inner = decl_node.child_by_field_name("declarator")  # type: ignore[union-attr]
        return _c_function_name(inner)
    if decl_node.type in ("identifier", "field_identifier"):  # type: ignore[union-attr]
        return decl_node.text.decode()  # type: ignore[union-attr]
    return None


class CParser(TreeSitterBase, LanguageParser):
    """Tree-sitter-based C parser.

    Extracts IMPORTS (#include), CALLS, and function definitions.
    C has no classes, inheritance, or annotations.
    """

    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "c",
    ) -> ParseResult:
        """Parse a C source file and return its graph representation.

        Args:
            file_path: Repo-relative path to the file.
            content: Full file content as a string.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Always "c".

        Returns:
            ParseResult with the file node, symbol nodes, and edges.
        """
        parser = self._get_ts_parser("c")
        content_bytes = content.encode("utf-8")
        tree = parser.parse(content_bytes)
        root = tree.root_node

        file_node = LexicalNode(
            node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, file_path, "file"),
            node_type="file",
            name=file_path,
            file=file_path,
            line_start=1,
            line_end=root.end_point[0] + 1,
            language=language,
            tenant_id=tenant_id,
            repo_id=repo_id,
        )
        result = ParseResult(file_node=file_node)

        result.nodes.extend(self._extract_c_nodes(root, file_path, tenant_id, repo_id, language))
        result.edges.extend(
            self._extract_c_includes(root, file_node.node_id, file_path, tenant_id, repo_id)
        )
        fn_nodes = [n for n in result.nodes if n.node_type == "function"]
        result.edges.extend(
            self._extract_call_edges(root, fn_nodes, file_path, tenant_id, repo_id, language)
        )
        return result

    def _extract_c_nodes(
        self,
        root: object,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> list[LexicalNode]:
        """Extract function definition nodes from C source.

        Args:
            root: AST root node.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Language string.

        Returns:
            List of extracted LexicalNode objects.
        """
        nodes: list[LexicalNode] = []
        for node in _walk(root):
            if node.type == "function_definition":
                decl = node.child_by_field_name("declarator")
                name = _c_function_name(decl)
                if name:
                    nodes.append(LexicalNode(
                        node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, name, "function"),
                        node_type="function",
                        name=name,
                        file=file_path,
                        line_start=node.start_point[0] + 1,
                        line_end=node.end_point[0] + 1,
                        language=language,
                        tenant_id=tenant_id,
                        repo_id=repo_id,
                    ))
        return nodes

    def _extract_c_includes(
        self,
        root: object,
        file_node_id: str,
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Extract #include directives as import edges.

        Args:
            root: AST root node.
            file_node_id: ID of the file node.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of imports GraphEdge objects.
        """
        edges: list[GraphEdge] = []
        seen: set[str] = set()
        for node in _walk(root):
            if node.type != "preproc_include":
                continue
            path_node = node.child_by_field_name("path")
            if path_node is None:
                continue
            module = _strip_quotes(path_node.text.decode()).strip("<>")
            if not module or module in seen:
                continue
            seen.add(module)
            edges.append(GraphEdge(
                edge_id=GraphEdge.make_id(file_node_id, "imports", module),
                edge_type="imports",
                source_id=file_node_id,
                target_id=module,
                target_name=module,
                file=file_path,
                line=node.start_point[0] + 1,
                tenant_id=tenant_id,
                repo_id=repo_id,
            ))
        return edges


from . import register_language  # noqa: E402

register_language("c", CParser, frozenset({".c", ".h"}))
