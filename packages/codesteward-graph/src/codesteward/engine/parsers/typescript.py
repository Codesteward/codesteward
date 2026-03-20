"""TypeScript / JavaScript / TSX parser (tree-sitter AST). Requires ``tree-sitter-typescript`` and ``tree-sitter-javascript`` (install with ``uv pip install -e '.[graph]'``).
"""


from typing import Any

import structlog

from ._ast_utils import (
    _SQL_RE,
    TreeSitterBase,
    _node_has_child_type,
    _strip_quotes,
    _walk,
)
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult

log = structlog.get_logger()


# Express / Fastify / Koa request property names treated as taint sources.
# Covers req.body (Express), request.body (Fastify), ctx.query (Koa), etc.
_EXPRESS_REQUEST_PROPS: frozenset[str] = frozenset(
    {"body", "query", "params", "headers", "cookies", "files"}
)

# Common request object parameter names used by Express, Fastify, and Koa.
_EXPRESS_REQUEST_PARAM_NAMES: frozenset[str] = frozenset({"req", "request", "ctx"})

# NestJS parameter decorator names that mark method parameters as taint sources.
# These appear as decorators on individual parameters, e.g.:
#   create(@Body() dto: CreateUserDto, @Param('id') id: string)
_NESTJS_PARAM_DECORATORS: frozenset[str] = frozenset(
    {
        "Body", "Param", "Query", "Headers", "Req", "Request",
        "Ip", "HostParam", "Session", "UploadedFile", "UploadedFiles",
    }
)


# ===========================================================================
# AST-based TypeScript/JavaScript parser (tree-sitter)
# ===========================================================================


class TypeScriptParser(TreeSitterBase, LanguageParser):
    """Tree-sitter-based TypeScript/JavaScript/TSX parser.

    All TS-specific extraction methods are concentrated here. Shared methods
    (_extract_call_edges, _extract_callee_name) are inherited from TreeSitterBase.
    """


    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "typescript",
    ) -> ParseResult:
        """Parse a TypeScript/JavaScript file via tree-sitter.

        Args:
            file_path: Repo-relative path to the file.
            content: Full file content as a string.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: "typescript", "tsx", "javascript", or "jsx".

        Returns:
            ParseResult with the file node, symbol nodes, and edges.
        """
        # Map tsx/jsx to their grammar keys
        grammar_lang = language
        if language == "jsx":
            grammar_lang = "javascript"

        parser = self._get_ts_parser(grammar_lang)
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

        result.nodes.extend(
            self._extract_ts_nodes(root, file_path, tenant_id, repo_id, language)
        )
        result.edges.extend(
            self._extract_ts_imports(root, file_node.node_id, file_path, tenant_id, repo_id)
        )
        result.nodes.extend(
            self._extract_sql_expressions(root, file_path, tenant_id, repo_id, language)
        )

        # CALLS edges
        fn_nodes = [n for n in result.nodes if n.node_type == "function"]
        result.edges.extend(
            self._extract_call_edges(root, fn_nodes, file_path, tenant_id, repo_id, language)
        )


        # GUARDED_BY edges
        result.edges.extend(
            self._extract_ts_guarded_by(root, fn_nodes, result.nodes, file_path, tenant_id, repo_id)
        )

        # PROTECTED_BY edges (Express router scope)
        result.edges.extend(
            self._extract_express_protected_by(
                root, fn_nodes, result.nodes, file_path, tenant_id, repo_id
            )
        )

        # Parameter extraction (enriches function node metadata in-place)
        self._extract_ts_parameters(root, fn_nodes, language)

        # Express taint source nodes and edges (req.body/req.query/... → handler)
        taint_nodes, taint_edges = self._extract_express_taint_sources(
            root, fn_nodes, file_path, tenant_id, repo_id, language
        )
        result.nodes.extend(taint_nodes)
        result.edges.extend(taint_edges)

        # NestJS parameter decorator taint source nodes and edges
        nestjs_nodes, nestjs_edges = self._extract_nestjs_taint_sources(
            root, fn_nodes, file_path, tenant_id, repo_id, language
        )
        result.nodes.extend(nestjs_nodes)
        result.edges.extend(nestjs_edges)

        return result

    # ------------------------------------------------------------------
    # TypeScript / JavaScript node extraction
    # ------------------------------------------------------------------

    def _extract_ts_nodes(
        self,
        root: Any,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> list[LexicalNode]:
        """Extract lexical nodes from a TypeScript/JavaScript AST.

        Only top-level declarations and class members are extracted to keep
        node counts focused on the meaningful structural symbols.

        Args:
            root: AST root node (program).
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Source language string.

        Returns:
            List of ``LexicalNode`` objects.
        """
        nodes: list[LexicalNode] = []
        for child in root.children:
            self._process_ts_toplevel(child, file_path, tenant_id, repo_id, language, False, nodes)
        return nodes

    def _process_ts_toplevel(
        self,
        node: Any,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
        exported: bool,
        out: list[LexicalNode],
    ) -> None:
        """Process a single top-level TS/JS AST node and append to *out*.

        Args:
            node: A direct child of the program node.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Source language string.
            exported: Whether this declaration was preceded by ``export``.
            out: Output list to append discovered nodes to.
        """
        ntype = node.type

        if ntype == "export_statement":
            decl = node.child_by_field_name("declaration")
            if decl:
                self._process_ts_toplevel(
                    decl, file_path, tenant_id, repo_id, language, True, out
                )
            return

        if ntype == "function_declaration":
            fn = self._ts_fn_node(node, file_path, tenant_id, repo_id, language, exported)
            if fn:
                out.append(fn)
            return

        if ntype == "class_declaration":
            cls = self._ts_class_node(node, file_path, tenant_id, repo_id, language, exported)
            if cls:
                out.append(cls)
            # Extract methods from the class body
            body = node.child_by_field_name("body")
            if body:
                for member in body.children:
                    if member.type == "method_definition":
                        m = self._ts_method_node(
                            member, file_path, tenant_id, repo_id, language
                        )
                        if m:
                            out.append(m)
            return

        if ntype in ("lexical_declaration", "variable_declaration"):
            for declarator in node.named_children:
                if declarator.type != "variable_declarator":
                    continue
                value = declarator.child_by_field_name("value")
                if value and value.type in ("arrow_function", "function_expression"):
                    fn = self._ts_arrow_fn_node(
                        declarator, value, file_path, tenant_id, repo_id, language, exported
                    )
                    if fn:
                        out.append(fn)
                else:
                    var = self._ts_var_node(
                        declarator, file_path, tenant_id, repo_id, language, exported
                    )
                    if var:
                        out.append(var)

    def _ts_fn_node(
        self,
        node: Any,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
        exported: bool,
    ) -> LexicalNode | None:
        """Build a ``LexicalNode`` from a ``function_declaration`` AST node."""
        name_node = node.child_by_field_name("name")
        if not name_node:
            return None
        name = name_node.text.decode()
        is_async = _node_has_child_type(node, "async")
        return LexicalNode(
            node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, name, "function"),
            node_type="function",
            name=name,
            file=file_path,
            line_start=node.start_point[0] + 1,
            line_end=node.end_point[0] + 1,
            language=language,
            tenant_id=tenant_id,
            repo_id=repo_id,
            exported=exported,
            is_async=is_async,
        )

    def _ts_class_node(
        self,
        node: Any,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
        exported: bool,
    ) -> LexicalNode | None:
        """Build a ``LexicalNode`` from a ``class_declaration`` AST node.

        Also appends ``extends`` edges for the inheritance chain to the
        parent ParseResult via side-effect — no, actually edges are returned
        separately via ``_extract_ts_imports``.  Inheritance edges come from
        the referential extraction step instead.
        """
        name_node = node.child_by_field_name("name")
        if not name_node:
            return None
        return LexicalNode(
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
            exported=exported,
        )

    def _ts_method_node(
        self,
        node: Any,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> LexicalNode | None:
        """Build a ``LexicalNode`` from a ``method_definition`` AST node."""
        name_node = node.child_by_field_name("name")
        if not name_node:
            return None
        name = name_node.text.decode()
        is_async = _node_has_child_type(node, "async")
        return LexicalNode(
            node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, name, "function"),
            node_type="function",
            name=name,
            file=file_path,
            line_start=node.start_point[0] + 1,
            line_end=node.end_point[0] + 1,
            language=language,
            tenant_id=tenant_id,
            repo_id=repo_id,
            exported=False,
            is_async=is_async,
        )

    def _ts_arrow_fn_node(
        self,
        declarator: Any,
        value: Any,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
        exported: bool,
    ) -> LexicalNode | None:
        """Build a ``LexicalNode`` for an arrow/function-expression variable."""
        name_node = declarator.child_by_field_name("name")
        if not name_node:
            return None
        name = name_node.text.decode()
        is_async = _node_has_child_type(value, "async")
        return LexicalNode(
            node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, name, "function"),
            node_type="function",
            name=name,
            file=file_path,
            line_start=declarator.start_point[0] + 1,
            line_end=value.end_point[0] + 1,
            language=language,
            tenant_id=tenant_id,
            repo_id=repo_id,
            exported=exported,
            is_async=is_async,
        )

    def _ts_var_node(
        self,
        declarator: Any,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
        exported: bool,
    ) -> LexicalNode | None:
        """Build a ``LexicalNode`` for a plain variable declarator."""
        name_node = declarator.child_by_field_name("name")
        if not name_node or name_node.type != "identifier":
            return None
        name = name_node.text.decode()
        return LexicalNode(
            node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, name, "variable"),
            node_type="variable",
            name=name,
            file=file_path,
            line_start=declarator.start_point[0] + 1,
            language=language,
            tenant_id=tenant_id,
            repo_id=repo_id,
            exported=exported,
        )

    # ------------------------------------------------------------------
    # TypeScript / JavaScript import & inheritance edge extraction
    # ------------------------------------------------------------------

    def _extract_ts_imports(
        self,
        root: Any,
        file_node_id: str,
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Extract import and inheritance edges from a TS/JS AST.

        Handles:
          - ES ``import … from '…'`` statements
          - CommonJS ``require('…')`` calls
          - Class ``extends`` clauses

        Args:
            root: AST root node.
            file_node_id: ID of the file's ``LexicalNode`` (import source).
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of ``GraphEdge`` objects.
        """
        edges: list[GraphEdge] = []
        for node in _walk(root):
            if node.type == "import_statement":
                source = node.child_by_field_name("source")
                if source:
                    module = _strip_quotes(source.text.decode())
                    edges.append(
                        GraphEdge(
                            edge_id=GraphEdge.make_id(file_node_id, "imports", module),
                            edge_type="imports",
                            source_id=file_node_id,
                            target_id=module,
                            target_name=module,
                            file=file_path,
                            line=node.start_point[0] + 1,
                            tenant_id=tenant_id,
                            repo_id=repo_id,
                        )
                    )

            elif node.type == "call_expression":
                fn = node.child_by_field_name("function")
                if fn and fn.type == "identifier" and fn.text == b"require":
                    args = node.child_by_field_name("arguments")
                    if args:
                        for arg in args.named_children:
                            if arg.type in ("string", "template_string"):
                                module = _strip_quotes(arg.text.decode())
                                edges.append(
                                    GraphEdge(
                                        edge_id=GraphEdge.make_id(
                                            file_node_id, "imports", module
                                        ),
                                        edge_type="imports",
                                        source_id=file_node_id,
                                        target_id=module,
                                        target_name=module,
                                        file=file_path,
                                        line=node.start_point[0] + 1,
                                        tenant_id=tenant_id,
                                        repo_id=repo_id,
                                    )
                                )
                                break

            elif node.type == "class_declaration":
                # Extends clause lives in the class_heritage node, not body —
                # walk the class_declaration's named children
                for child in node.named_children:
                    if child.type == "class_heritage":
                        for hchild in child.named_children:
                            if hchild.type == "extends_clause":
                                base_node = hchild.named_children[0] if hchild.named_children else None
                                if base_node:
                                    base_name = base_node.text.decode()
                                    name_node = node.child_by_field_name("name")
                                    if name_node:
                                        src_id = LexicalNode.make_id(
                                            tenant_id, repo_id, file_path,
                                            name_node.text.decode(), "class"
                                        )
                                        edges.append(
                                            GraphEdge(
                                                edge_id=GraphEdge.make_id(src_id, "extends", base_name),
                                                edge_type="extends",
                                                source_id=src_id,
                                                target_id=base_name,
                                                target_name=base_name,
                                                file=file_path,
                                                line=node.start_point[0] + 1,
                                                tenant_id=tenant_id,
                                                repo_id=repo_id,
                                            )
                                        )

        return edges

    # ------------------------------------------------------------------
    # SQL context tagging
    # ------------------------------------------------------------------

    def _extract_sql_expressions(
        self,
        root: Any,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> list[LexicalNode]:
        """Emit expression nodes for template literals containing SQL keywords.

        Walks the full AST looking for ``template_string`` nodes whose text
        matches one or more SQL keywords.  Each matching literal gets a
        ``LexicalNode`` with ``node_type="expression"`` and
        ``metadata={"context": "sql_query"}``.  These nodes feed the semantic
        layer's SQL injection detection queries.

        Args:
            root: AST root node.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Source language string.

        Returns:
            List of expression ``LexicalNode`` objects.
        """
        nodes: list[LexicalNode] = []
        seen_lines: set[int] = set()

        for node in _walk(root):
            if node.type != "template_string":
                continue
            text = node.text.decode()
            if not _SQL_RE.search(text):
                continue
            line = node.start_point[0] + 1
            if line in seen_lines:
                continue
            seen_lines.add(line)
            name = f"sql_template:{line}"
            nodes.append(
                LexicalNode(
                    node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, name, "expression"),
                    node_type="expression",
                    name=name,
                    file=file_path,
                    line_start=line,
                    line_end=node.end_point[0] + 1,
                    language=language,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                    metadata={"context": "sql_query"},
                )
            )
            log.debug(
                "sql_template_tagged",
                file=file_path,
                line=line,
            )

        return nodes

    # ------------------------------------------------------------------
    # GUARDED_BY edge extraction
    # ------------------------------------------------------------------

    def _extract_ts_guarded_by(
        self,
        root: Any,
        fn_nodes: list[LexicalNode],
        result_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Extract GUARDED_BY edges for TypeScript/JavaScript decorator nodes.

        In tree-sitter-typescript the decorator nodes live in different places
        depending on what they annotate:

        * **Class decorators**: inside ``export_statement`` as siblings of
          ``class_declaration`` (not children of ``class_declaration``).
        * **Method decorators**: inside ``class_body`` as siblings of
          ``method_definition`` (not children of ``method_definition``).

        Args:
            root: AST root node.
            fn_nodes: Function LexicalNodes from this file.
            result_nodes: All LexicalNodes from this file (unused directly).
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of ``guarded_by`` ``GraphEdge`` objects.
        """
        edges: list[GraphEdge] = []
        seen: set[str] = set()

        def _emit(source_id: str, guard_name: str, line: int) -> None:
            key = f"{source_id}:{guard_name}"
            if key in seen:
                return
            seen.add(key)
            edges.append(
                GraphEdge(
                    edge_id=GraphEdge.make_id(source_id, "guarded_by", guard_name),
                    edge_type="guarded_by",
                    source_id=source_id,
                    target_id=guard_name,
                    target_name=guard_name,
                    file=file_path,
                    line=line,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                )
            )

        for node in _walk(root):
            # ── Class decorators ──────────────────────────────────────────────
            if node.type in ("export_statement", "program"):
                class_node = None
                decorators: list[Any] = []
                for child in node.children:
                    if child.type == "decorator":
                        decorators.append(child)
                    elif child.type == "class_declaration":
                        class_node = child
                if class_node and decorators:
                    name_node = class_node.child_by_field_name("name")
                    if name_node:
                        source_id = LexicalNode.make_id(
                            tenant_id, repo_id, file_path,
                            name_node.text.decode(), "class",
                        )
                        for dec in decorators:
                            guard_name = self._ts_decorator_name(dec)
                            if guard_name:
                                _emit(source_id, guard_name, dec.start_point[0] + 1)

            # ── Method / function decorators ──────────────────────────────────
            elif node.type == "class_body":
                pending_decorators: list[Any] = []
                for child in node.children:
                    if child.type == "decorator":
                        pending_decorators.append(child)
                    elif child.type in ("method_definition", "function_declaration"):
                        if pending_decorators:
                            name_node = child.child_by_field_name("name")
                            if name_node:
                                source_id = LexicalNode.make_id(
                                    tenant_id, repo_id, file_path,
                                    name_node.text.decode(), "function",
                                )
                                for dec in pending_decorators:
                                    guard_name = self._ts_decorator_name(dec)
                                    if guard_name:
                                        _emit(source_id, guard_name, dec.start_point[0] + 1)
                        pending_decorators = []
                    else:
                        # Any non-decorator, non-method child resets the accumulator
                        pending_decorators = []

        return edges

    def _ts_decorator_name(self, decorator_node: Any) -> str | None:
        """Extract the name from a TypeScript/JavaScript ``decorator`` AST node.

        Handles plain identifiers (``@Injectable``), call expressions
        (``@UseGuards(AuthGuard)``), and member expressions
        (``@Module.decorator``).

        Args:
            decorator_node: A tree-sitter ``decorator`` node.

        Returns:
            Decorator name string, or ``None`` if unresolvable.
        """
        for child in decorator_node.children:
            if child.type == "identifier":
                return str(child.text.decode())
            if child.type == "call_expression":
                fn = child.child_by_field_name("function")
                if fn:
                    if fn.type == "identifier":
                        return str(fn.text.decode())
                    if fn.type == "member_expression":
                        prop = fn.child_by_field_name("property")
                        return str(prop.text.decode()) if prop else str(fn.text.decode())
            if child.type == "member_expression":
                prop = child.child_by_field_name("property")
                return str(prop.text.decode()) if prop else str(child.text.decode())
        return None

    # ------------------------------------------------------------------
    # PROTECTED_BY edge extraction (Express router scope)
    # ------------------------------------------------------------------

    def _extract_express_protected_by(
        self,
        root: Any,
        fn_nodes: list[LexicalNode],
        result_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Emit PROTECTED_BY edges for Express/Koa ``router.use(middleware)`` scope.

        Two-pass approach:
          Pass 1 — Collect every ``{var}.use({fn})`` call with its line and the
                   variable name (``app``, ``router``, etc.).
          Pass 2 — For every route registration ``{var}.{method}(path, handler)``
                   on the same variable at a line **after** any ``use()`` on that
                   variable, emit PROTECTED_BY(handler → middleware).

        Args:
            root: AST root node.
            fn_nodes: Function LexicalNodes from this file.
            result_nodes: All LexicalNodes from this file (unused directly).
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of ``protected_by`` ``GraphEdge`` objects.
        """
        edges: list[GraphEdge] = []
        seen: set[str] = set()

        def _emit(source_id: str, guard_name: str, line: int) -> None:
            key = f"{source_id}:{guard_name}"
            if key in seen:
                return
            seen.add(key)
            target_id = f"middleware:{tenant_id}:{repo_id}:{guard_name}"
            edges.append(
                GraphEdge(
                    edge_id=GraphEdge.make_id(source_id, "protected_by", guard_name),
                    edge_type="protected_by",
                    source_id=source_id,
                    target_id=target_id,
                    target_name=guard_name,
                    file=file_path,
                    line=line,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                )
            )

        _HTTP_METHODS = frozenset(["get", "post", "put", "patch", "delete", "all", "use"])

        # ── Pass 1: collect use() calls ────────────────────────────────────
        # {variable_name → [(middleware_fn_name, line), ...]}
        use_calls: dict[str, list[tuple[str, int]]] = {}

        for node in _walk(root):
            if node.type != "call_expression":
                continue
            fn_node = node.child_by_field_name("function")
            if not fn_node or fn_node.type != "member_expression":
                continue
            prop = fn_node.child_by_field_name("property")
            if not prop or prop.text.decode() != "use":
                continue
            obj = fn_node.child_by_field_name("object")
            if not obj:
                continue
            var_name = obj.text.decode()
            args = node.child_by_field_name("arguments")
            if not args:
                continue
            mw_name: str | None = None
            for arg in args.children:
                if arg.type == "identifier":
                    mw_name = arg.text.decode()
                    break
                if arg.type == "member_expression":
                    prop2 = arg.child_by_field_name("property")
                    mw_name = prop2.text.decode() if prop2 else arg.text.decode()
                    break
                if arg.type in ("arrow_function", "function_expression", "function"):
                    break
            if mw_name:
                use_calls.setdefault(var_name, []).append(
                    (mw_name, node.start_point[0] + 1)
                )

        if not use_calls:
            return edges

        # Build name→node_id map for quick lookup
        fn_id_by_name: dict[str, str] = {n.name: n.node_id for n in fn_nodes}

        # ── Pass 2: match route registrations below a use() call ───────────
        for node in _walk(root):
            if node.type != "call_expression":
                continue
            fn_node = node.child_by_field_name("function")
            if not fn_node or fn_node.type != "member_expression":
                continue
            prop = fn_node.child_by_field_name("property")
            if not prop or prop.text.decode() not in _HTTP_METHODS - {"use"}:
                continue
            obj = fn_node.child_by_field_name("object")
            if not obj:
                continue
            var_name = obj.text.decode()
            if var_name not in use_calls:
                continue

            route_line = node.start_point[0] + 1
            applicable_mw = [
                (mw, mw_line)
                for mw, mw_line in use_calls[var_name]
                if mw_line < route_line
            ]
            if not applicable_mw:
                continue

            args = node.child_by_field_name("arguments")
            if not args:
                continue
            handler_names: list[str] = []
            for arg in args.children:
                if arg.type == "identifier":
                    handler_names.append(arg.text.decode())
            for handler_name in handler_names:
                source_id = fn_id_by_name.get(handler_name)
                if not source_id:
                    source_id = LexicalNode.make_id(
                        tenant_id, repo_id, file_path, handler_name, "function"
                    )
                for mw_name, mw_line in applicable_mw:
                    _emit(source_id, mw_name, mw_line)

        return edges

    # ------------------------------------------------------------------
    # Parameter extraction (enriches function node metadata in-place)
    # ------------------------------------------------------------------

    def _extract_ts_parameters(
        self, root: Any, fn_nodes: list[LexicalNode], language: str
    ) -> None:
        """Populate ``metadata['parameters']`` for TypeScript/JS function nodes.

        Args:
            root: AST root node.
            fn_nodes: Function LexicalNodes to enrich (modified in-place).
            language: Source language string.
        """
        fn_by_line: dict[int, LexicalNode] = {n.line_start: n for n in fn_nodes}

        for node in _walk(root):
            if node.type not in (
                "function_declaration", "method_definition",
                "function", "arrow_function",
            ):
                continue
            fn_line = node.start_point[0] + 1
            fn_node = fn_by_line.get(fn_line)
            if fn_node is None:
                continue
            params_node = node.child_by_field_name("parameters")
            if not params_node:
                continue
            params: list[dict[str, Any]] = []
            for param in params_node.children:
                if param.type in (",", "(", ")"):
                    continue
                p = self._ts_param_info(param)
                if p:
                    params.append(p)
            if params:
                fn_node.metadata["parameters"] = params

    def _ts_param_info(self, param_node: Any) -> dict[str, Any] | None:
        """Extract name and type from a TypeScript parameter AST node.

        Args:
            param_node: A tree-sitter parameter node.

        Returns:
            Dict with ``name`` and ``type`` keys, or ``None``.
        """
        if param_node.type in ("required_parameter", "optional_parameter"):
            name_node = param_node.child_by_field_name("pattern")
            type_node = param_node.child_by_field_name("type")
            name = name_node.text.decode() if name_node else None
            type_text: str | None = None
            if type_node:
                type_text = type_node.text.decode().lstrip(":").strip()
            return {"name": name, "type": type_text} if name else None
        if param_node.type == "identifier":
            return {"name": param_node.text.decode(), "type": None}
        if param_node.type == "rest_pattern":
            inner = param_node.named_children[0] if param_node.named_children else None
            return {"name": f"...{inner.text.decode()}" if inner else "...rest", "type": None}
        return None

    # ------------------------------------------------------------------
    # Express taint source emission
    # ------------------------------------------------------------------

    def _extract_express_taint_sources(
        self,
        root: Any,
        fn_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> tuple[list[LexicalNode], list[GraphEdge]]:
        """Emit taint-source nodes and CALLS edges for Express.js request inputs.

        Detects member expression accesses on common Express request parameter
        names (``req``, ``request``, ``ctx``):

        - ``req.body``, ``req.query``, ``req.params``, ``req.headers``,
          ``req.cookies``, ``req.files``

        For each access, emits a synthetic external ``LexicalNode`` with
        ``file="express"`` and name ``req.<prop>``, plus a ``CALLS`` edge
        **from** that source node **to** the enclosing handler function.

        Args:
            root: AST root node.
            fn_nodes: Function LexicalNodes from this file.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Source language string.

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

        for node in _walk(root):
            if node.type != "member_expression":
                continue
            obj_node = node.child_by_field_name("object")
            prop_node = node.child_by_field_name("property")
            if not obj_node or not prop_node:
                continue
            if obj_node.type != "identifier":
                continue
            if obj_node.text.decode() not in _EXPRESS_REQUEST_PARAM_NAMES:
                continue
            prop_name = prop_node.text.decode()
            if prop_name not in _EXPRESS_REQUEST_PROPS:
                continue

            # Find the tightest enclosing function by line range
            node_line = node.start_point[0] + 1
            caller: LexicalNode | None = None
            for fn in scoped_fns:
                if fn.line_start <= node_line <= (fn.line_end or node_line) and (
                    caller is None or fn.line_start > caller.line_start
                ):
                    caller = fn
            if caller is None:
                continue

            source_name = f"req.{prop_name}"
            source_id = LexicalNode.make_id(tenant_id, repo_id, "express", source_name, "external")
            if source_id not in seen_nodes:
                seen_nodes.add(source_id)
                nodes.append(LexicalNode(
                    node_id=source_id,
                    node_type="external",
                    name=source_name,
                    file="express",
                    line_start=1,
                    line_end=1,
                    language=language,
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

        return nodes, edges

    # ------------------------------------------------------------------
    # NestJS parameter decorator taint source emission
    # ------------------------------------------------------------------

    def _extract_nestjs_taint_sources(
        self,
        root: Any,
        fn_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> tuple[list[LexicalNode], list[GraphEdge]]:
        """Emit taint-source nodes and CALLS edges for NestJS parameter decorators.

        NestJS binds HTTP request data to controller method parameters via
        decorators applied directly to each parameter:

        .. code-block:: typescript

            @Post('users/:id')
            create(
                @Param('id') id: string,
                @Query('role') role: string,
                @Body() dto: CreateUserDto,
            ): Promise<User> { ... }

        For each parameter carrying a decorator whose name is in
        ``_NESTJS_PARAM_DECORATORS``, emits a synthetic external ``LexicalNode``
        with ``file="nestjs"`` and ``name="nestjs.<DecoratorName>"``, plus a
        ``CALLS`` edge from that source node to the enclosing method.

        Args:
            root: AST root node.
            fn_nodes: Function LexicalNodes from this file.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Source language string.

        Returns:
            Tuple of ``(nodes, edges)`` — synthetic source LexicalNodes and
            CALLS edges pointing from each source to its handler.
        """
        nodes: list[LexicalNode] = []
        edges: list[GraphEdge] = []
        seen_nodes: set[str] = set()
        seen_edges: set[str] = set()

        fn_id_by_name: dict[str, str] = {n.name: n.node_id for n in fn_nodes}

        def _emit(decorator_name: str, method_name: str, line: int) -> None:
            source_name = f"nestjs.{decorator_name}"
            source_id = LexicalNode.make_id(tenant_id, repo_id, "nestjs", source_name, "external")
            if source_id not in seen_nodes:
                seen_nodes.add(source_id)
                nodes.append(LexicalNode(
                    node_id=source_id,
                    node_type="external",
                    name=source_name,
                    file="nestjs",
                    line_start=1,
                    line_end=1,
                    language=language,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))
            handler_id = fn_id_by_name.get(method_name) or LexicalNode.make_id(
                tenant_id, repo_id, file_path, method_name, "function"
            )
            edge_key = f"{source_id}:{handler_id}"
            if edge_key not in seen_edges:
                seen_edges.add(edge_key)
                edges.append(GraphEdge(
                    edge_id=GraphEdge.make_id(source_id, "calls", method_name),
                    edge_type="calls",
                    source_id=source_id,
                    target_id=handler_id,
                    target_name=method_name,
                    file=file_path,
                    line=line,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))

        for node in _walk(root):
            if node.type != "class_body":
                continue
            for member in node.children:
                if member.type != "method_definition":
                    continue
                name_node = member.child_by_field_name("name")
                if not name_node:
                    continue
                method_name = name_node.text.decode()
                method_line = member.start_point[0] + 1

                params_node = member.child_by_field_name("parameters")
                if not params_node:
                    continue

                for param in params_node.children:
                    if param.type not in ("required_parameter", "optional_parameter"):
                        continue
                    # Parameter decorators appear as named children of type "decorator"
                    for pchild in param.children:
                        if pchild.type != "decorator":
                            continue
                        dec_name = self._ts_decorator_name(pchild)
                        if dec_name and dec_name in _NESTJS_PARAM_DECORATORS:
                            _emit(dec_name, method_name, method_line)
                            break  # one decorator per param is enough to classify it

        return nodes, edges

