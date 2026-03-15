"""C++ parser (tree-sitter AST). Requires ``tree-sitter-cpp`` (install with ``uv pip install -e '.[graph-cpp]'``).
"""

import structlog

from ._ast_utils import TreeSitterBase, _strip_quotes, _walk
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult
from .c import _c_function_name  # reuse helper

log = structlog.get_logger()

_KEYWORDS = frozenset({
    "if", "else", "for", "while", "do", "switch", "case", "return", "new",
    "delete", "throw", "try", "catch", "namespace", "class", "struct",
    "public", "private", "protected", "virtual", "override", "static",
    "const", "void", "auto", "template", "typename", "using", "nullptr",
    "true", "false", "this",
})


class CppParser(TreeSitterBase, LanguageParser):
    """Tree-sitter-based C++ parser.

    Extracts IMPORTS (#include), CALLS, EXTENDS (base_class_clause),
    and class/function nodes. C++ ``[[attribute]]`` GUARDED_BY is not
    emitted (rare in practice; the heuristic is unreliable without full
    scope analysis).
    """

    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "cpp",
    ) -> ParseResult:
        """Parse a C++ source file and return its graph representation.

        Args:
            file_path: Repo-relative path to the file.
            content: Full file content as a string.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Always "cpp".

        Returns:
            ParseResult with the file node, symbol nodes, and edges.
        """
        parser = self._get_ts_parser("cpp")
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

        result.nodes.extend(self._extract_cpp_nodes(root, file_path, tenant_id, repo_id, language))
        class_nodes = [n for n in result.nodes if n.node_type == "class"]
        result.edges.extend(
            self._extract_cpp_extends(root, class_nodes, file_path, tenant_id, repo_id)
        )
        result.edges.extend(
            self._extract_c_includes(root, file_node.node_id, file_path, tenant_id, repo_id)
        )
        fn_nodes = [n for n in result.nodes if n.node_type == "function"]
        result.edges.extend(
            self._extract_call_edges(root, fn_nodes, file_path, tenant_id, repo_id, language)
        )
        return result

    def _extract_cpp_nodes(
        self,
        root: object,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> list[LexicalNode]:
        """Extract class and function nodes from C++ source.

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
            if node.type == "class_specifier":
                name_node = node.child_by_field_name("name")
                if name_node:
                    nodes.append(LexicalNode(
                        node_id=LexicalNode.make_id(
                            tenant_id, repo_id, file_path, name_node.text.decode(), "class"
                        ),
                        node_type="class",
                        name=name_node.text.decode(),
                        file=file_path,
                        line_start=node.start_point[0] + 1,
                        line_end=node.end_point[0] + 1,
                        language=language,
                        tenant_id=tenant_id,
                        repo_id=repo_id,
                    ))
            elif node.type == "function_definition":
                decl = node.child_by_field_name("declarator")
                name = _c_function_name(decl)
                if name and name not in _KEYWORDS:
                    nodes.append(LexicalNode(
                        node_id=LexicalNode.make_id(
                            tenant_id, repo_id, file_path, name, "function"
                        ),
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

    def _extract_cpp_extends(
        self,
        root: object,
        class_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Emit EXTENDS edges from base_class_clause.

        Args:
            root: AST root node.
            class_nodes: Class LexicalNodes extracted from this file.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of extends GraphEdge objects.
        """
        name_to_node = {n.name: n for n in class_nodes}
        edges: list[GraphEdge] = []
        for node in _walk(root):
            if node.type != "class_specifier":
                continue
            name_node = node.child_by_field_name("name")
            if not name_node:
                continue
            src = name_to_node.get(name_node.text.decode())
            if not src:
                continue
            for child in node.children:
                if child.type == "base_class_clause":
                    for bchild in child.children:
                        if bchild.type == "type_identifier":
                            base = bchild.text.decode()
                            if base not in _KEYWORDS:
                                edges.append(GraphEdge(
                                    edge_id=GraphEdge.make_id(src.node_id, "extends", base),
                                    edge_type="extends",
                                    source_id=src.node_id,
                                    target_id=base,
                                    target_name=base,
                                    file=file_path,
                                    line=node.start_point[0] + 1,
                                    tenant_id=src.tenant_id,
                                    repo_id=src.repo_id,
                                ))
        return edges

    def _extract_c_includes(
        self,
        root: object,
        file_node_id: str,
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Extract #include directives (same logic as C).

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

register_language("cpp", CppParser, frozenset({".cpp", ".cxx", ".cc", ".hpp", ".hxx"}))
