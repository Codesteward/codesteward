"""Go parser (tree-sitter AST). Requires ``tree-sitter-go`` (install with ``uv pip install -e '.[graph-go]'``).
"""

from typing import Any

import structlog

from ._ast_utils import TreeSitterBase, _strip_quotes, _walk
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult

log = structlog.get_logger()

# net/http (*http.Request) direct method names treated as taint sources.
_GO_HTTP_DIRECT_SOURCES: frozenset[str] = frozenset(
    {"FormValue", "PostFormValue", "PathValue", "PostForm", "MultipartForm"}
)

# Chained selector patterns on *http.Request: (inner field, outer field) → source name.
# Covers r.Header.Get(...) and r.URL.Query().
_GO_HTTP_CHAINED_SOURCES: dict[tuple[str, str], str] = {
    ("Header", "Get"): "Header.Get",
    ("URL", "Query"): "URL.Query",
    ("URL", "RawQuery"): "URL.RawQuery",
}

# Gin (*gin.Context) method names treated as taint sources.
# These are unique to gin.Context and unlikely to collide with other types.
_GIN_CONTEXT_METHODS: frozenset[str] = frozenset(
    {
        "Param", "Query", "DefaultQuery", "QueryArray", "QueryMap",
        "PostForm", "DefaultPostForm", "PostFormArray", "PostFormMap",
        "GetHeader", "Cookie", "FormFile", "MultipartForm",
        "GetRawData",
        "ShouldBind", "ShouldBindJSON", "ShouldBindXML", "ShouldBindQuery",
        "ShouldBindHeader", "ShouldBindUri", "ShouldBindWith",
        "BindJSON", "BindXML", "BindQuery", "BindHeader", "BindUri", "Bind",
    }
)

# Echo (echo.Context) method names treated as taint sources.
_ECHO_CONTEXT_METHODS: frozenset[str] = frozenset(
    {
        "Param", "QueryParam", "QueryParams", "QueryString",
        "FormValue", "FormParams", "FormFile", "MultipartForm",
        "Cookie", "Cookies",
        "Bind", "BindJSON", "BindXML", "BindForm",
    }
)

# Combined set for receiver-method detection (Gin ∪ Echo minus ambiguous names).
# "Param", "Cookie", "FormFile", "MultipartForm", "Bind" appear in both —
# that's fine; they're all taint sources regardless of which framework.
_GO_FRAMEWORK_CONTEXT_METHODS: frozenset[str] = _GIN_CONTEXT_METHODS | _ECHO_CONTEXT_METHODS

# Package-level function names that extract path parameters (Chi, Gorilla Mux).
# Detected as call_expression where function is a selector on a package identifier.
_GO_PATH_PARAM_PKG_FUNCTIONS: dict[str, str] = {
    # chi.URLParam(r, "key") → package "chi", function "URLParam"
    "URLParam": "chi.URLParam",
    # chi.URLParamFromCtx(ctx, "key") → package "chi", function "URLParamFromCtx"
    "URLParamFromCtx": "chi.URLParamFromCtx",
    # mux.Vars(r) → package "mux", function "Vars"
    "Vars": "mux.Vars",
}


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
        # net/http taint source nodes and edges (r.FormValue/r.Header.Get/... → handler)
        taint_nodes, taint_edges = self._extract_go_http_taint_sources(
            root, fn_nodes, file_path, tenant_id, repo_id
        )
        result.nodes.extend(taint_nodes)
        result.edges.extend(taint_edges)
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


    # ------------------------------------------------------------------
    # Go net/http taint source emission
    # ------------------------------------------------------------------

    def _extract_go_http_taint_sources(
        self,
        root: Any,
        fn_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> tuple[list[LexicalNode], list[GraphEdge]]:
        """Emit taint-source nodes and CALLS edges for Go HTTP framework request inputs.

        Covers four call patterns:

        **net/http direct** — ``r.FormValue``, ``r.PostFormValue``,
        ``r.PathValue``, ``r.PostForm``, ``r.MultipartForm``.  Identified by
        method name alone; emits ``file="net/http"``.

        **net/http chained** — ``r.Header.Get(...)`` and ``r.URL.Query()``
        via two-level ``selector_expression`` chains.  Emits ``file="net/http"``.

        **Gin / Echo context methods** — ``c.Param``, ``c.Query``,
        ``c.QueryParam``, ``c.PostForm``, ``c.GetHeader``,
        ``c.ShouldBindJSON``, etc.  Detected by method name (unique to these
        frameworks); emits ``file="gin_echo"``.

        **Chi / Gorilla Mux package functions** — ``chi.URLParam(r, "key")``,
        ``chi.URLParamFromCtx(ctx, "key")``, ``mux.Vars(r)``.  Detected as
        ``selector_expression`` call where the operand is a package-name
        identifier; emits ``file="chi_mux"``.

        For each detected call, emits:

        - A synthetic external ``LexicalNode`` with the framework-specific
          ``file`` marker and name equal to the method/function name.
        - A ``CALLS`` edge **from** the source node **to** the enclosing
          handler function.

        Args:
            root: AST root node.
            fn_nodes: Function LexicalNodes from this file.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            Tuple of ``(nodes, edges)`` — synthetic source LexicalNodes and
            CALLS edges pointing from each source to its handler.
        """
        nodes: list[LexicalNode] = []
        edges: list[GraphEdge] = []
        seen_nodes: set[str] = set()
        seen_edges: set[str] = set()

        scoped_fns = sorted(
            [fn for fn in fn_nodes if fn.line_end is not None],
            key=lambda n: n.line_start,
        )

        def _emit(source_name: str, source_file: str, node_line: int) -> None:
            # Find the tightest enclosing function by line range
            caller: LexicalNode | None = None
            for fn in scoped_fns:
                if fn.line_start <= node_line <= (fn.line_end or node_line) and (
                    caller is None or fn.line_start > caller.line_start
                ):
                    caller = fn
            if caller is None:
                return

            source_id = LexicalNode.make_id(tenant_id, repo_id, source_file, source_name, "external")
            if source_id not in seen_nodes:
                seen_nodes.add(source_id)
                nodes.append(LexicalNode(
                    node_id=source_id,
                    node_type="external",
                    name=source_name,
                    file=source_file,
                    line_start=1,
                    line_end=1,
                    language="go",
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))

            edge_key = f"{source_id}:{caller.node_id}"
            if edge_key not in seen_edges:
                seen_edges.add(edge_key)
                edges.append(GraphEdge(
                    edge_id=GraphEdge.make_id(source_id, "calls", caller.name),
                    edge_type="calls",
                    source_id=source_id,
                    target_id=caller.node_id,
                    target_name=caller.name,
                    file=file_path,
                    line=node_line,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))

        for node in _walk(root):
            if node.type != "call_expression":
                continue
            fn_field = node.child_by_field_name("function")
            if fn_field is None or fn_field.type != "selector_expression":
                continue
            outer_field = fn_field.child_by_field_name("field")
            operand = fn_field.child_by_field_name("operand")
            if outer_field is None or operand is None:
                continue

            outer_name = outer_field.text.decode()
            node_line = node.start_point[0] + 1

            if operand.type == "identifier":
                # net/http direct: r.FormValue(...), r.PostFormValue(...), etc.
                if outer_name in _GO_HTTP_DIRECT_SOURCES:
                    _emit(outer_name, "net/http", node_line)
                    continue

                # Gin / Echo context methods: c.Param(...), c.Query(...), etc.
                # Detected by method name uniqueness — no type inference available.
                if outer_name in _GO_FRAMEWORK_CONTEXT_METHODS:
                    _emit(outer_name, "gin_echo", node_line)
                    continue

                # Chi / Gorilla Mux package functions: chi.URLParam(r, ...), mux.Vars(r)
                # The operand is the package identifier (e.g. "chi", "mux").
                source_name = _GO_PATH_PARAM_PKG_FUNCTIONS.get(outer_name)
                if source_name:
                    _emit(source_name, "chi_mux", node_line)
                    continue

            # net/http chained: r.Header.Get(...), r.URL.Query()
            if operand.type == "selector_expression":
                inner_field = operand.child_by_field_name("field")
                inner_operand = operand.child_by_field_name("operand")
                if (
                    inner_field is not None
                    and inner_operand is not None
                    and inner_operand.type == "identifier"
                ):
                    key = (inner_field.text.decode(), outer_name)
                    chained_name = _GO_HTTP_CHAINED_SOURCES.get(key)
                    if chained_name:
                        _emit(chained_name, "net/http", node_line)

        return nodes, edges


from . import register_language  # noqa: E402

register_language("go", GoParser, frozenset({".go"}))
