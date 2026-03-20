"""Kotlin parser (tree-sitter AST). Requires ``tree-sitter-kotlin`` (install with ``uv pip install -e '.[graph-kotlin]'``).
"""

from typing import Any

import structlog

from ._ast_utils import TreeSitterBase, _walk
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult

log = structlog.get_logger()

# Spring Boot / Spring MVC annotations on Kotlin function parameters.
# Same annotations as Java (both Spring MVC and Spring WebFlux apply here).
_KOTLIN_SPRING_PARAM_ANNOTATIONS: frozenset[str] = frozenset({
    "RequestParam", "PathVariable", "RequestBody", "RequestHeader",
    "ModelAttribute", "RequestAttribute", "RequestPart", "CookieValue",
    # Jakarta / JAX-RS (Quarkus, Micronaut on Kotlin)
    "PathParam", "QueryParam", "FormParam", "HeaderParam",
    "CookieParam", "MatrixParam", "BeanParam",
    # Micronaut HTTP
    "QueryValue", "Body", "Header", "Part",
})

# Ktor ApplicationCall accessor names that expose HTTP input.
# Accessed as call.parameters["name"], call.request.queryParameters["name"], etc.
_KOTLIN_KTOR_PARAM_NAMES: frozenset[str] = frozenset({
    "parameters", "queryParameters",
})

# Ktor receive methods (call.receive<T>(), call.receiveText(), etc.)
_KOTLIN_KTOR_RECEIVE_METHODS: frozenset[str] = frozenset({
    "receive", "receiveText", "receiveChannel", "receiveNullable", "receiveOrNull",
    "receiveStream", "receiveMultipart",
})

# Http4k and other Kotlin HTTP library request methods.
_KOTLIN_HTTP4K_METHODS: frozenset[str] = frozenset({
    "query", "path", "bodyString", "header", "cookie",
})

_KEYWORDS = frozenset({
    "if", "else", "for", "while", "do", "when", "return", "throw", "try",
    "catch", "finally", "in", "is", "as", "object", "class", "interface",
    "fun", "val", "var", "by", "where", "constructor", "init", "companion",
    "override", "abstract", "open", "sealed", "data", "enum", "annotation",
    "suspend", "inline", "internal", "private", "protected", "public",
    "external", "actual", "expect", "operator", "infix", "tailrec",
    "crossinline", "noinline", "reified", "vararg",
})


class KotlinParser(TreeSitterBase, LanguageParser):
    """Tree-sitter-based Kotlin parser.

    Extracts IMPORTS, CALLS, EXTENDS, GUARDED_BY, and parameter metadata.
    """

    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "kotlin",
    ) -> "ParseResult":
        parser = self._get_ts_parser("kotlin")
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
            self._extract_kt_nodes(root, file_path, tenant_id, repo_id, language)
        )
        class_nodes = [n for n in result.nodes if n.node_type == "class"]
        result.edges.extend(
            self._extract_kt_extends(root, class_nodes, file_path, tenant_id, repo_id)
        )
        result.edges.extend(
            self._extract_kt_imports(root, file_node.node_id, file_path, tenant_id, repo_id)
        )
        result.edges.extend(
            self._extract_kt_guarded_by(root, result.nodes, file_path, tenant_id, repo_id)
        )

        fn_nodes = [n for n in result.nodes if n.node_type == "function"]
        result.edges.extend(
            self._extract_call_edges(root, fn_nodes, file_path, tenant_id, repo_id, language)
        )
        self._extract_kt_parameters(root, fn_nodes)

        # Taint source nodes and edges (Spring Boot / Ktor / Http4k HTTP input)
        taint_nodes, taint_edges = self._extract_kotlin_taint_sources(
            root, fn_nodes, file_path, tenant_id, repo_id, language
        )
        result.nodes.extend(taint_nodes)
        result.edges.extend(taint_edges)

        return result

    # ------------------------------------------------------------------
    # Node extraction
    # ------------------------------------------------------------------

    def _extract_kt_nodes(
        self,
        root: object,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> "list[LexicalNode]":
        nodes: list[LexicalNode] = []
        for node in _walk(root):
            if node.type == "class_declaration":
                name_node = next(
                    (c for c in node.children if c.type == "identifier"), None
                )
                if name_node is None:
                    continue
                name = name_node.text.decode()
                class_node = LexicalNode(
                    node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, name, "class"),
                    node_type="class",
                    name=name,
                    file=file_path,
                    line_start=node.start_point[0] + 1,
                    line_end=node.end_point[0] + 1,
                    language=language,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                )
                nodes.append(class_node)

                # EXTENDS edges extracted separately by _extract_kt_extends()

            elif node.type == "function_declaration":
                name_node = next(
                    (c for c in node.children if c.type == "identifier"), None
                )
                if name_node is None:
                    continue
                name = name_node.text.decode()
                if name in _KEYWORDS:
                    continue

                # Check for suspend modifier
                is_async = False
                for child in node.children:
                    if child.type == "modifiers":
                        for mod in child.children:
                            if mod.type == "function_modifier" and mod.text.decode() == "suspend":
                                is_async = True

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
                    is_async=is_async,
                ))

        return nodes

    # ------------------------------------------------------------------
    # EXTENDS extraction
    # ------------------------------------------------------------------

    def _extract_kt_extends(
        self,
        root: object,
        class_nodes: "list[LexicalNode]",
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> "list[GraphEdge]":
        """Emit EXTENDS edges for Kotlin class/interface delegation_specifiers."""
        name_to_node = {n.name: n for n in class_nodes}
        edges: list[GraphEdge] = []
        for node in _walk(root):
            if node.type != "class_declaration":
                continue
            name_node = next(
                (c for c in node.children if c.type == "identifier"), None
            )
            if name_node is None:
                continue
            name = name_node.text.decode()
            src = name_to_node.get(name)
            if src is None:
                continue
            for child in node.children:
                if child.type == "delegation_specifiers":
                    for spec in child.children:
                        if spec.type == "delegation_specifier":
                            for inner in _walk(spec):
                                if inner.type == "user_type":
                                    ident = next(
                                        (c for c in inner.children
                                         if c.type == "identifier"), None
                                    )
                                    if ident:
                                        base_name = ident.text.decode()
                                        if base_name not in _KEYWORDS:
                                            edges.append(GraphEdge(
                                                edge_id=GraphEdge.make_id(
                                                    src.node_id, "extends", base_name
                                                ),
                                                edge_type="extends",
                                                source_id=src.node_id,
                                                target_id=base_name,
                                                target_name=base_name,
                                                file=file_path,
                                                line=node.start_point[0] + 1,
                                                tenant_id=tenant_id,
                                                repo_id=repo_id,
                                            ))
        return edges

    # ------------------------------------------------------------------
    # Import extraction
    # ------------------------------------------------------------------

    def _extract_kt_imports(
        self,
        root: object,
        file_node_id: str,
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> "list[GraphEdge]":
        edges: list[GraphEdge] = []
        for node in _walk(root):
            # The "import" node type is the full import statement
            if node.type != "import":
                continue
            # Collect identifiers to build the module path
            parts: list[str] = []
            for child in _walk(node):
                if child.type == "identifier":
                    parts.append(child.text.decode())
            if parts:
                module = ".".join(parts)
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
    # GUARDED_BY extraction (Kotlin annotations)
    # ------------------------------------------------------------------

    def _extract_kt_guarded_by(
        self,
        root: object,
        nodes: "list[LexicalNode]",
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> "list[GraphEdge]":
        """Emit GUARDED_BY for @Annotation on classes and functions."""
        node_map = {n.name: n for n in nodes if n.node_type in ("function", "class")}
        edges: list[GraphEdge] = []

        for decl in _walk(root):
            if decl.type not in ("class_declaration", "function_declaration"):
                continue
            name_node = next(
                (c for c in decl.children if c.type == "identifier"), None
            )
            if name_node is None:
                continue
            decl_name = name_node.text.decode()
            target = node_map.get(decl_name)
            if target is None:
                continue

            for child in decl.children:
                if child.type != "modifiers":
                    continue
                for mod in child.children:
                    if mod.type != "annotation":
                        continue
                    # annotation → constructor_invocation → user_type → identifier
                    # or annotation → user_type → identifier
                    for inner in _walk(mod):
                        if inner.type == "user_type":
                            ident = next(
                                (c for c in inner.children if c.type == "identifier"),
                                None,
                            )
                            if ident:
                                annot_name = ident.text.decode()
                                edges.append(GraphEdge(
                                    edge_id=GraphEdge.make_id(
                                        target.node_id, "guarded_by", annot_name
                                    ),
                                    edge_type="guarded_by",
                                    source_id=target.node_id,
                                    target_id=annot_name,
                                    target_name=annot_name,
                                    file=file_path,
                                    line=decl.start_point[0] + 1,
                                    tenant_id=tenant_id,
                                    repo_id=repo_id,
                                ))
                            break  # one annotation name per annotation node

        return edges

    # ------------------------------------------------------------------
    # Parameter extraction
    # ------------------------------------------------------------------

    def _extract_kt_parameters(
        self,
        root: object,
        fn_nodes: "list[LexicalNode]",
    ) -> None:
        """Populate ``metadata['parameters']`` on function nodes in-place."""
        fn_map = {n.name: n for n in fn_nodes}
        for node in _walk(root):
            if node.type != "function_declaration":
                continue
            name_node = next(
                (c for c in node.children if c.type == "identifier"), None
            )
            if name_node is None:
                continue
            fn = fn_map.get(name_node.text.decode())
            if fn is None:
                continue
            param_list = next(
                (c for c in node.children if c.type == "function_value_parameters"), None
            )
            if param_list is None:
                continue
            params: list[dict[str, Any]] = []
            for p in param_list.children:
                if p.type != "parameter":
                    continue
                pname_node = next(
                    (c for c in p.children if c.type == "identifier"), None
                )
                ptype_node = next(
                    (c for c in p.children if c.type == "user_type"), None
                )
                params.append({
                    "name": pname_node.text.decode() if pname_node else "",
                    "type": ptype_node.text.decode() if ptype_node else None,
                })
            fn.metadata["parameters"] = params


    # ------------------------------------------------------------------
    # Taint source emission (Spring Boot / Ktor / Http4k HTTP input)
    # ------------------------------------------------------------------

    def _extract_kotlin_taint_sources(
        self,
        root: object,
        fn_nodes: "list[LexicalNode]",
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> "tuple[list[LexicalNode], list[GraphEdge]]":
        """Emit taint-source nodes and CALLS edges for Kotlin HTTP input patterns.

        Detects two patterns:

        1. **Spring Boot / MVC / WebFlux parameter annotations** — ``@RequestParam``,
           ``@PathVariable``, ``@RequestBody``, ``@RequestHeader``, etc. applied to
           function parameters.  In tree-sitter-kotlin, parameter annotations appear
           as ``annotation`` nodes inside ``parameter`` nodes (within
           ``function_value_parameters``).

        2. **Ktor ApplicationCall accessors** — ``call.parameters["name"]`` and
           ``call.request.queryParameters["name"]`` (indexed access), and
           ``call.receive<T>()``, ``call.receiveText()`` (method calls).  Detected
           via identifier chains ending with ``parameters`` / ``queryParameters``
           subscript access or ``receive*`` function calls.

        3. **Http4k** — ``request.query("name")``, ``request.path("id")``,
           ``request.bodyString()``, ``request.header("name")``, etc.

        Args:
            root: AST root node.
            fn_nodes: Function LexicalNodes from this file.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Language string.

        Returns:
            Tuple of ``(nodes, edges)``.
        """
        nodes: list[LexicalNode] = []
        edges: list[GraphEdge] = []
        seen_nodes: set[str] = set()
        seen_edges: set[str] = set()

        fn_id_by_name: dict[str, str] = {n.name: n.node_id for n in fn_nodes}
        scoped_fns = sorted(
            [fn for fn in fn_nodes if fn.line_end is not None],
            key=lambda n: n.line_start,
        )

        def _find_caller(line: int) -> "LexicalNode | None":
            caller: LexicalNode | None = None
            for fn in scoped_fns:
                if fn.line_start <= line <= (fn.line_end or line) and (
                    caller is None or fn.line_start > caller.line_start
                ):
                    caller = fn
            return caller

        def _emit(source_name: str, fn_name: str, fn_id: str, line: int) -> None:
            source_id = LexicalNode.make_id(tenant_id, repo_id, "kotlin_http", source_name, "external")
            if source_id not in seen_nodes:
                seen_nodes.add(source_id)
                nodes.append(LexicalNode(
                    node_id=source_id,
                    node_type="external",
                    name=source_name,
                    file="kotlin_http",
                    line_start=1,
                    line_end=1,
                    language=language,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))
            edge_key = f"{source_id}:{fn_id}"
            if edge_key not in seen_edges:
                seen_edges.add(edge_key)
                edges.append(GraphEdge(
                    edge_id=GraphEdge.make_id(source_id, "calls", fn_name),
                    edge_type="calls",
                    source_id=source_id,
                    target_id=fn_id,
                    target_name=fn_name,
                    file=file_path,
                    line=line,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))

        # ── Section 1: Spring Boot parameter annotations ─────────────────────
        for node in _walk(root):
            if node.type != "function_declaration":
                continue
            name_node = next(
                (c for c in node.children if c.type == "identifier"), None
            )
            if name_node is None:
                continue
            fn_name = name_node.text.decode()
            fn_id = fn_id_by_name.get(fn_name) or LexicalNode.make_id(
                tenant_id, repo_id, file_path, fn_name, "function"
            )
            param_list = next(
                (c for c in node.children if c.type == "function_value_parameters"),
                None,
            )
            if param_list is None:
                continue
            # Annotations appear on `parameter_modifiers` siblings, not inside
            # `parameter` nodes.  Walk the whole param list for annotations.
            for pchild in _walk(param_list):
                if pchild.type != "annotation":
                    continue
                for inner in _walk(pchild):
                    if inner.type == "user_type":
                        ident = next(
                            (c for c in inner.children if c.type == "identifier"), None
                        )
                        if ident:
                            annot = ident.text.decode()
                            if annot in _KOTLIN_SPRING_PARAM_ANNOTATIONS:
                                _emit(
                                    f"kotlin_http.{annot}",
                                    fn_name,
                                    fn_id,
                                    pchild.start_point[0] + 1,
                                )
                            break

        # ── Section 2: Ktor call.parameters / receive ─────────────────────────
        for node in _walk(root):
            node_type: str = node.type

            if node_type == "call_expression":
                # Detect call.receive<T>() / call.receiveText() etc.
                fn_field = node.child_by_field_name("calleeExpression") or next(
                    (c for c in node.children
                     if c.type in ("navigation_expression", "simple_identifier")), None
                )
                if fn_field is None:
                    continue
                fn_text = fn_field.text.decode()
                # Match "call.receive", "call.receiveText", etc.
                parts = fn_text.split(".")
                if len(parts) >= 2 and parts[-2] == "call" and parts[-1] in _KOTLIN_KTOR_RECEIVE_METHODS:
                    node_line = node.start_point[0] + 1
                    caller = _find_caller(node_line)
                    if caller:
                        _emit(f"kotlin_http.{parts[-1]}", caller.name, caller.node_id, node_line)

            elif node_type == "index_access_expression":
                # Detect call.parameters["id"] / call.request.queryParameters["name"]
                expr = next(
                    (c for c in node.children
                     if c.type in ("navigation_expression", "simple_identifier")), None
                )
                if expr is None:
                    continue
                expr_text = expr.text.decode()
                matched_accessor = next(
                    (acc for acc in _KOTLIN_KTOR_PARAM_NAMES if expr_text.endswith(f".{acc}")),
                    None,
                )
                if matched_accessor:
                    node_line = node.start_point[0] + 1
                    caller = _find_caller(node_line)
                    if caller:
                        _emit(f"kotlin_http.{matched_accessor}", caller.name, caller.node_id, node_line)

        # ── Section 3: Http4k request.query / path / bodyString / header ──────
        for node in _walk(root):
            if node.type != "call_expression":
                continue
            fn_field = node.child_by_field_name("calleeExpression") or next(
                (c for c in node.children
                 if c.type in ("navigation_expression", "simple_identifier")), None
            )
            if fn_field is None:
                continue
            fn_text = fn_field.text.decode()
            parts = fn_text.split(".")
            if (len(parts) >= 2
                    and parts[-2] in ("request", "req")
                    and parts[-1] in _KOTLIN_HTTP4K_METHODS):
                node_line = node.start_point[0] + 1
                caller = _find_caller(node_line)
                if caller:
                    _emit(f"kotlin_http.{parts[-1]}", caller.name, caller.node_id, node_line)

        return nodes, edges


# Auto-register when this module is imported
from . import register_language  # noqa: E402

register_language("kotlin", KotlinParser, frozenset({".kt", ".kts"}))
