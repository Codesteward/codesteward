"""Go parser (tree-sitter AST). Requires ``tree-sitter-go`` (install with ``uv pip install -e '.[graph-go]'``).
"""

import structlog

from ._ast_utils import TreeSitterBase, _strip_quotes, _walk
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult

log = structlog.get_logger()


class GoParser(TreeSitterBase, LanguageParser):
    """Tree-sitter-based Go parser.

    Extracts IMPORTS, CALLS, PROTECTED_BY, and struct/function nodes.
    Go has no class inheritance (EXTENDS) and no annotations (GUARDED_BY).
    PROTECTED_BY is emitted for Gin/Echo router group middleware patterns.
    """

    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "go",
    ) -> ParseResult:
        """Parse a Go source file and return its graph representation.

        Args:
            file_path: Repo-relative path to the file.
            content: Full file content as a string.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Always "go".

        Returns:
            ParseResult with the file node, symbol nodes, and edges.
        """
        parser = self._get_ts_parser("go")
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

        result.nodes.extend(self._extract_go_nodes(root, file_path, tenant_id, repo_id, language))
        result.edges.extend(
            self._extract_go_imports(root, file_node.node_id, file_path, tenant_id, repo_id)
        )
        fn_nodes = [n for n in result.nodes if n.node_type == "function"]
        result.edges.extend(
            self._extract_call_edges(root, fn_nodes, file_path, tenant_id, repo_id, language)
        )
        # PROTECTED_BY edges (Gin/Echo router group scope)
        result.edges.extend(
            self._extract_go_protected_by(
                root, fn_nodes, result.nodes, file_path, tenant_id, repo_id
            )
        )
        return result

    # ------------------------------------------------------------------
    # Node extraction
    # ------------------------------------------------------------------

    def _extract_go_nodes(
        self,
        root: object,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> list[LexicalNode]:
        """Extract function, method, and struct nodes from Go source.

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
            if node.type == "function_declaration" or node.type == "method_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    nodes.append(LexicalNode(
                        node_id=LexicalNode.make_id(
                            tenant_id, repo_id, file_path, name_node.text.decode(), "function"
                        ),
                        node_type="function",
                        name=name_node.text.decode(),
                        file=file_path,
                        line_start=node.start_point[0] + 1,
                        line_end=node.end_point[0] + 1,
                        language=language,
                        tenant_id=tenant_id,
                        repo_id=repo_id,
                    ))
            elif node.type == "type_declaration":
                # Walk child type_spec nodes; emit class only for struct types
                for child in node.children:
                    if child.type == "type_spec":
                        name_node = child.child_by_field_name("name")
                        type_node = child.child_by_field_name("type")
                        if name_node and type_node and type_node.type == "struct_type":
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
        return nodes

    # ------------------------------------------------------------------
    # Import extraction
    # ------------------------------------------------------------------

    def _extract_go_imports(
        self,
        root: object,
        file_node_id: str,
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Extract import edges from Go import_spec nodes.

        Each import_spec has a 'path' field (interpreted_string_literal).

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
            if node.type != "import_spec":
                continue
            path_node = node.child_by_field_name("path")
            if path_node is None:
                continue
            module = _strip_quotes(path_node.text.decode())
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


    # ------------------------------------------------------------------
    # PROTECTED_BY extraction (Gin / Echo router group middleware)
    # ------------------------------------------------------------------

    def _extract_go_protected_by(
        self,
        root: object,
        fn_nodes: list[LexicalNode],
        result_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Emit PROTECTED_BY edges for Gin/Echo router group middleware.

        Detects the two-step pattern::

            api := r.Group("/api")
            api.Use(authMiddleware)
            api.GET("/profile", getProfile)

        Pass 1 — collect ``{var}.Use(mw, ...)`` calls; build var → [middleware] map.
        Pass 2 — find ``{var}.GET/POST/...("/path", handler)`` calls; for each handler
                  that maps to a known fn_node (or creates an external node), emit
                  PROTECTED_BY from handler → every registered middleware on that var.

        Args:
            root: AST root node.
            fn_nodes: All function LexicalNodes extracted from this file.
            result_nodes: All LexicalNodes (mutated in-place with new external nodes).
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of ``protected_by`` GraphEdge objects.
        """
        _HTTP_METHODS = frozenset({
            "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS",
            "Any", "Handle", "HandleFunc",
        })

        fn_name_to_node: dict[str, LexicalNode] = {n.name: n for n in fn_nodes}
        edges: list[GraphEdge] = []
        seen: set[str] = set()

        def _emit(source_id: str, guard_name: str, line: int) -> None:
            key = f"{source_id}:{guard_name}"
            if key in seen:
                return
            seen.add(key)
            target_id = f"middleware:{tenant_id}:{repo_id}:{guard_name}"
            edges.append(GraphEdge(
                edge_id=GraphEdge.make_id(source_id, "protected_by", guard_name),
                edge_type="protected_by",
                source_id=source_id,
                target_id=target_id,
                target_name=guard_name,
                file=file_path,
                line=line,
                tenant_id=tenant_id,
                repo_id=repo_id,
            ))

        # Pass 1: {var}.Use(mw1, mw2, ...) → var_middlewares[var] = [mw1, mw2, ...]
        var_middlewares: dict[str, list[str]] = {}
        for node in _walk(root):
            if node.type != "call_expression":
                continue
            fn_field = node.child_by_field_name("function")
            if fn_field is None or fn_field.type != "selector_expression":
                continue
            field_node = fn_field.child_by_field_name("field")
            if field_node is None or field_node.text.decode() != "Use":
                continue
            obj_node = fn_field.child_by_field_name("operand")
            if obj_node is None or obj_node.type != "identifier":
                continue
            var_name = obj_node.text.decode()
            args_node = node.child_by_field_name("arguments")
            if args_node is None:
                continue
            for arg in args_node.children:
                if arg.type == "identifier":
                    var_middlewares.setdefault(var_name, []).append(arg.text.decode())

        if not var_middlewares:
            return edges

        # Pass 2: {var}.GET/POST/...("/path", handler) → PROTECTED_BY
        for node in _walk(root):
            if node.type != "call_expression":
                continue
            fn_field = node.child_by_field_name("function")
            if fn_field is None or fn_field.type != "selector_expression":
                continue
            field_node = fn_field.child_by_field_name("field")
            if field_node is None or field_node.text.decode() not in _HTTP_METHODS:
                continue
            obj_node = fn_field.child_by_field_name("operand")
            if obj_node is None or obj_node.type != "identifier":
                continue
            var_name = obj_node.text.decode()
            middlewares = var_middlewares.get(var_name)
            if not middlewares:
                continue
            args_node = node.child_by_field_name("arguments")
            if args_node is None:
                continue
            # Last identifier argument is the handler function
            handler_idents = [c for c in args_node.children if c.type == "identifier"]
            if not handler_idents:
                continue
            handler_name = handler_idents[-1].text.decode()
            src = fn_name_to_node.get(handler_name)
            if src is None:
                ext_id = LexicalNode.make_id(
                    tenant_id, repo_id, file_path, handler_name, "external"
                )
                src = LexicalNode(
                    node_id=ext_id,
                    node_type="external",
                    name=handler_name,
                    file=file_path,
                    line_start=node.start_point[0] + 1,
                    line_end=node.start_point[0] + 1,
                    language="go",
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                )
                result_nodes.append(src)
                fn_name_to_node[handler_name] = src  # prevent duplicate externals

            for mw in middlewares:
                _emit(src.node_id, mw, node.start_point[0] + 1)

        return edges


from . import register_language  # noqa: E402

register_language("go", GoParser, frozenset({".go"}))
