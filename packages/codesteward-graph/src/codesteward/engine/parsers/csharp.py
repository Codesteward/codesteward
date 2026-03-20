"""C# parser (tree-sitter AST). Requires ``tree-sitter-c-sharp`` (install with ``uv pip install -e '.[graph-csharp]'``).
"""

from typing import Any

import structlog

from ._ast_utils import TreeSitterBase, _walk
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult

log = structlog.get_logger()

# ASP.NET Core parameter binding attributes that mark method parameters as HTTP input sources.
# [FromQuery], [FromBody], [FromRoute], [FromForm], [FromHeader] are the standard MVC/Minimal API
# attributes for binding controller action / endpoint parameters to request data.
_CS_HTTP_PARAM_ATTRIBUTES: frozenset[str] = frozenset({
    "FromQuery", "FromRoute", "FromBody", "FromForm", "FromHeader",
})

# HttpRequest / HttpContext property names that expose raw HTTP input.
# Accessed as request.Query["key"], request.Form["field"], context.Request.Headers["name"], etc.
_CS_HTTP_REQUEST_MEMBERS: frozenset[str] = frozenset({
    "Query", "Form", "Body", "Headers", "Cookies", "RouteValues",
})

_KEYWORDS = frozenset({
    "if", "else", "for", "foreach", "while", "do", "switch", "case", "return",
    "new", "throw", "catch", "finally", "try", "using", "namespace", "class",
    "interface", "enum", "struct", "record", "void", "var", "int", "string",
    "bool", "object", "base", "this", "static", "public", "private", "protected",
    "internal", "abstract", "sealed", "virtual", "override", "readonly", "const",
    "async", "await", "yield", "in", "out", "ref", "params", "get", "set",
})


class CSharpParser(TreeSitterBase, LanguageParser):
    """Tree-sitter-based C# parser.

    Extracts all edge types: IMPORTS, CALLS, EXTENDS, GUARDED_BY, PROTECTED_BY,
    plus function parameter metadata.
    PROTECTED_BY is emitted for ASP.NET Core Minimal API
    ``MapGroup(...).RequireAuthorization().MapGet(...)`` chains.
    """

    _DECL_TYPES = frozenset({
        "class_declaration", "interface_declaration", "struct_declaration",
        "enum_declaration", "record_declaration",
    })
    _METHOD_TYPES = frozenset({"method_declaration", "constructor_declaration"})

    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "csharp",
    ) -> "ParseResult":
        parser = self._get_ts_parser("csharp")
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

        result.nodes.extend(self._extract_cs_nodes(root, file_path, tenant_id, repo_id, language))
        class_nodes = [n for n in result.nodes if n.node_type == "class"]
        result.edges.extend(
            self._extract_cs_extends(root, class_nodes, file_path, tenant_id, repo_id)
        )
        result.edges.extend(
            self._extract_cs_imports(root, file_node.node_id, file_path, tenant_id, repo_id)
        )
        result.edges.extend(
            self._extract_cs_guarded_by(root, result.nodes, file_path, tenant_id, repo_id)
        )

        fn_nodes = [n for n in result.nodes if n.node_type == "function"]
        result.edges.extend(
            self._extract_call_edges(root, fn_nodes, file_path, tenant_id, repo_id, language)
        )
        self._extract_cs_parameters(root, fn_nodes)

        # PROTECTED_BY edges (ASP.NET Core Minimal API MapGroup+RequireAuthorization)
        result.edges.extend(
            self._extract_cs_protected_by(
                root, fn_nodes, result.nodes, file_path, tenant_id, repo_id
            )
        )

        # Taint source nodes and edges (ASP.NET Core HTTP input)
        taint_nodes, taint_edges = self._extract_cs_taint_sources(
            root, fn_nodes, file_path, tenant_id, repo_id, language
        )
        result.nodes.extend(taint_nodes)
        result.edges.extend(taint_edges)

        return result

    # ------------------------------------------------------------------
    # Node extraction
    # ------------------------------------------------------------------

    def _extract_cs_nodes(
        self,
        root: object,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> "list[LexicalNode]":
        nodes: list[LexicalNode] = []
        for node in _walk(root):
            if node.type in self._DECL_TYPES:
                name_node = node.child_by_field_name("name")
                if name_node is None:
                    # Some grammars use "identifier" child directly
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

                # EXTENDS edges extracted separately by _extract_cs_extends()

            elif node.type in self._METHOD_TYPES:
                name_node = node.child_by_field_name("name")
                if name_node is None:
                    name_node = next(
                        (c for c in node.children if c.type == "identifier"), None
                    )
                if name_node is None:
                    continue
                name = name_node.text.decode()
                is_async = any(
                    c.type == "modifier" and c.text.decode() == "async"
                    for c in node.children
                )
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

    def _extract_cs_extends(
        self,
        root: object,
        class_nodes: "list[LexicalNode]",
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> "list[GraphEdge]":
        """Emit EXTENDS edges for class/interface inheritance (base_list)."""
        name_to_node = {n.name: n for n in class_nodes}
        edges: list[GraphEdge] = []
        for node in _walk(root):
            if node.type not in self._DECL_TYPES:
                continue
            name_node = node.child_by_field_name("name")
            if name_node is None:
                name_node = next(
                    (c for c in node.children if c.type == "identifier"), None
                )
            if name_node is None:
                continue
            name = name_node.text.decode()
            src = name_to_node.get(name)
            if src is None:
                continue
            base_list = node.child_by_field_name("bases")
            if base_list is None:
                base_list = next(
                    (c for c in node.children if c.type == "base_list"), None
                )
            if base_list:
                for child in base_list.children:
                    if child.type in ("identifier", "generic_name"):
                        # For generic_name take the identifier child
                        if child.type == "generic_name":
                            ident = next(
                                (c for c in child.children if c.type == "identifier"), None
                            )
                            base_name = ident.text.decode() if ident else None
                        else:
                            base_name = child.text.decode()
                        if base_name and base_name not in _KEYWORDS:
                            edges.append(GraphEdge(
                                edge_id=GraphEdge.make_id(src.node_id, "extends", base_name),
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

    def _extract_cs_imports(
        self,
        root: object,
        file_node_id: str,
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> "list[GraphEdge]":
        edges: list[GraphEdge] = []
        for node in _walk(root):
            if node.type != "using_directive":
                continue
            # Collect all identifier/qualified_name text segments
            parts: list[str] = []
            for child in _walk(node):
                if child.type == "identifier" and child.text.decode() not in ("using", "static"):
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
    # GUARDED_BY extraction (C# attributes)
    # ------------------------------------------------------------------

    def _extract_cs_guarded_by(
        self,
        root: object,
        nodes: "list[LexicalNode]",
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> "list[GraphEdge]":
        """Emit GUARDED_BY edges for C# attribute annotations.

        Attributes appear as ``attribute_list`` → ``attribute`` children inside
        ``class_declaration``, ``method_declaration``, and
        ``constructor_declaration`` nodes.
        """
        node_map = {n.name: n for n in nodes if n.node_type in ("function", "class")}
        edges: list[GraphEdge] = []

        for decl in _walk(root):
            if decl.type not in self._DECL_TYPES | self._METHOD_TYPES:
                continue
            name_node = decl.child_by_field_name("name") or next(
                (c for c in decl.children if c.type == "identifier"), None
            )
            if name_node is None:
                continue
            decl_name = name_node.text.decode()
            target_node = node_map.get(decl_name)
            if target_node is None:
                continue

            for child in decl.children:
                if child.type != "attribute_list":
                    continue
                for attr in child.children:
                    if attr.type != "attribute":
                        continue
                    attr_name_node = attr.child_by_field_name("name") or next(
                        (c for c in attr.children if c.type == "identifier"), None
                    )
                    if attr_name_node is None:
                        continue
                    attr_name = attr_name_node.text.decode()
                    edges.append(GraphEdge(
                        edge_id=GraphEdge.make_id(target_node.node_id, "guarded_by", attr_name),
                        edge_type="guarded_by",
                        source_id=target_node.node_id,
                        target_id=attr_name,
                        target_name=attr_name,
                        file=file_path,
                        line=decl.start_point[0] + 1,
                        tenant_id=tenant_id,
                        repo_id=repo_id,
                    ))

        return edges

    # ------------------------------------------------------------------
    # Parameter extraction
    # ------------------------------------------------------------------

    def _extract_cs_parameters(
        self,
        root: object,
        fn_nodes: "list[LexicalNode]",
    ) -> None:
        """Populate ``metadata['parameters']`` on function nodes in-place."""
        fn_map = {n.name: n for n in fn_nodes}
        for node in _walk(root):
            if node.type not in self._METHOD_TYPES:
                continue
            name_node = node.child_by_field_name("name") or next(
                (c for c in node.children if c.type == "identifier"), None
            )
            if name_node is None:
                continue
            fn = fn_map.get(name_node.text.decode())
            if fn is None:
                continue
            param_list = next(
                (c for c in node.children if c.type == "parameter_list"), None
            )
            if param_list is None:
                continue
            params: list[dict[str, Any]] = []
            for p in param_list.children:
                if p.type != "parameter":
                    continue
                pname_node = p.child_by_field_name("name")
                ptype_node = p.child_by_field_name("type")
                params.append({
                    "name": pname_node.text.decode() if pname_node else "",
                    "type": ptype_node.text.decode() if ptype_node else None,
                })
            fn.metadata["parameters"] = params


    # ------------------------------------------------------------------
    # PROTECTED_BY extraction (ASP.NET Core Minimal API MapGroup chains)
    # ------------------------------------------------------------------

    def _extract_cs_protected_by(
        self,
        root: object,
        fn_nodes: list[LexicalNode],
        result_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Emit PROTECTED_BY edges for ASP.NET Core Minimal API route group chains.

        Detects chained ``MapGroup(...).RequireAuthorization().MapGet(...)`` patterns::

            app.MapGroup("/api")
               .RequireAuthorization()
               .MapGet("/profile", GetProfile);

        For each ``MapGet/MapPost/...`` call that sits downstream of a
        ``RequireAuthorization()`` or ``Authorize()`` call in the same chain,
        a PROTECTED_BY edge is emitted from the handler to the auth guard.

        Note: the two-step variable-assignment form (``var api = ...; api.MapGet(...)``)
        is not detected — only the chained form is supported.

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
        _MAP_METHODS = frozenset({"MapGet", "MapPost", "MapPut", "MapDelete", "MapPatch"})

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

        for node in _walk(root):
            if node.type != "invocation_expression":
                continue
            # tree-sitter-c-sharp uses "function" or "expression" field depending on version
            fn_field = node.child_by_field_name("function") or node.child_by_field_name("expression")
            if fn_field is None or fn_field.type != "member_access_expression":
                continue
            method_name_node = fn_field.child_by_field_name("name")
            if method_name_node is None or method_name_node.text.decode() not in _MAP_METHODS:
                continue

            # Extract handler from the argument list (second argument after the path)
            handler_name = self._cs_extract_map_handler(node)
            if not handler_name:
                continue

            # Walk the chain receiver upward looking for RequireAuthorization/Authorize
            chain = fn_field.child_by_field_name("expression")
            if not self._cs_chain_requires_auth(chain):
                continue

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
                    language="csharp",
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                )
                result_nodes.append(src)
                fn_name_to_node[handler_name] = src

            _emit(src.node_id, "RequireAuthorization", node.start_point[0] + 1)

        return edges

    def _cs_extract_map_handler(self, inv_node: object) -> str | None:
        """Extract the handler function name from a C# ``MapGet/MapPost/...`` call.

        Inspects the ``argument_list``; the second ``argument`` child (after the
        route path) is expected to be an identifier or member access naming the
        handler delegate.

        Args:
            inv_node: An ``invocation_expression`` AST node.

        Returns:
            Handler function name, or None if not resolvable.
        """
        arg_list = inv_node.child_by_field_name("argument_list")  # type: ignore[attr-defined]
        if arg_list is None:
            return None
        args = [c for c in arg_list.children if c.type == "argument"]
        if len(args) < 2:
            return None
        handler_arg = args[1]
        for child in handler_arg.children:
            if child.type == "identifier":
                return str(child.text.decode())
            if child.type == "member_access_expression":
                name_n = child.child_by_field_name("name")
                return str(name_n.text.decode()) if name_n else None
        return None

    def _cs_chain_requires_auth(self, chain_node: object) -> bool:
        """Walk a C# method chain to find ``RequireAuthorization()`` or ``Authorize()``.

        Follows ``member_access_expression.expression`` links upward to detect
        whether any call in the chain is an auth-requirement method.

        Args:
            chain_node: The ``expression`` field of a ``member_access_expression``
                        (i.e. the receiver of the ``MapGet/...`` call).

        Returns:
            True if the chain includes a ``RequireAuthorization`` or ``Authorize`` call.
        """
        _AUTH_METHODS = frozenset({"RequireAuthorization", "Authorize"})
        node = chain_node
        while node is not None:
            if node.type == "invocation_expression":  # type: ignore[attr-defined]
                fn = node.child_by_field_name("function") or node.child_by_field_name("expression")  # type: ignore[attr-defined]
                if fn and fn.type == "member_access_expression":
                    name_n = fn.child_by_field_name("name")
                    if name_n and name_n.text.decode() in _AUTH_METHODS:
                        return True
                    node = fn.child_by_field_name("expression")
                else:
                    break
            else:
                break
        return False


    # ------------------------------------------------------------------
    # Taint source emission (ASP.NET Core HTTP input)
    # ------------------------------------------------------------------

    def _extract_cs_taint_sources(
        self,
        root: object,
        fn_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> tuple[list[LexicalNode], list[GraphEdge]]:
        """Emit taint-source nodes and CALLS edges for ASP.NET Core HTTP input.

        Detects two patterns:

        1. **Parameter binding attributes** — ``[FromQuery]``, ``[FromRoute]``,
           ``[FromBody]``, ``[FromForm]``, ``[FromHeader]`` applied to individual
           method parameters in MVC controller actions or Minimal API endpoint
           handlers.  A synthetic external ``LexicalNode`` with
           ``file="aspnetcore"`` and ``name="aspnetcore.<Attribute>"`` is emitted,
           with a CALLS edge to the enclosing method.

        2. **Direct HttpRequest member access** — indexed access such as
           ``request.Query["key"]``, ``request.Form["field"]``,
           ``request.Headers["name"]``, ``request.Cookies["c"]``,
           ``request.Body``, ``request.RouteValues["id"]``.  Detected via
           ``element_access_expression`` whose base is a ``member_access_expression``
           with a property name in ``_CS_HTTP_REQUEST_MEMBERS``.

        Args:
            root: AST root node.
            fn_nodes: Function LexicalNodes from this file.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Language string.

        Returns:
            Tuple of ``(nodes, edges)`` — synthetic source LexicalNodes and
            CALLS edges pointing from each source to its handler.
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

        def _emit(source_name: str, method_name: str, method_id: str, line: int) -> None:
            source_id = LexicalNode.make_id(tenant_id, repo_id, "aspnetcore", source_name, "external")
            if source_id not in seen_nodes:
                seen_nodes.add(source_id)
                nodes.append(LexicalNode(
                    node_id=source_id,
                    node_type="external",
                    name=source_name,
                    file="aspnetcore",
                    line_start=1,
                    line_end=1,
                    language=language,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))
            edge_key = f"{source_id}:{method_id}"
            if edge_key not in seen_edges:
                seen_edges.add(edge_key)
                edges.append(GraphEdge(
                    edge_id=GraphEdge.make_id(source_id, "calls", method_name),
                    edge_type="calls",
                    source_id=source_id,
                    target_id=method_id,
                    target_name=method_name,
                    file=file_path,
                    line=line,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))

        # ── Section 1: parameter-level binding attributes ────────────────────
        for node in _walk(root):
            if node.type not in self._METHOD_TYPES:
                continue
            name_node = node.child_by_field_name("name") or next(
                (c for c in node.children if c.type == "identifier"), None
            )
            if name_node is None:
                continue
            method_name = name_node.text.decode()
            method_id = fn_id_by_name.get(method_name) or LexicalNode.make_id(
                tenant_id, repo_id, file_path, method_name, "function"
            )
            param_list = next(
                (c for c in node.children if c.type == "parameter_list"), None
            )
            if param_list is None:
                continue
            for param in param_list.children:
                if param.type != "parameter":
                    continue
                for pchild in param.children:
                    if pchild.type != "attribute_list":
                        continue
                    for attr in pchild.children:
                        if attr.type != "attribute":
                            continue
                        attr_name_node = attr.child_by_field_name("name") or next(
                            (c for c in attr.children
                             if c.type in ("identifier", "qualified_name")), None
                        )
                        if attr_name_node is None:
                            continue
                        # qualified names like "Microsoft.AspNetCore.Mvc.FromQuery" → take last part
                        attr_name = attr_name_node.text.decode().split(".")[-1]
                        if attr_name in _CS_HTTP_PARAM_ATTRIBUTES:
                            _emit(
                                f"aspnetcore.{attr_name}",
                                method_name,
                                method_id,
                                param.start_point[0] + 1,
                            )
                            break  # one matching attribute per parameter is enough

        # ── Section 2: HttpRequest indexed access ────────────────────────────
        # Matches: request.Query["key"], context.Request.Form["field"], etc.
        for node in _walk(root):
            if node.type != "element_access_expression":
                continue
            expr = node.child_by_field_name("expression")
            if expr is None or expr.type != "member_access_expression":
                continue
            prop = expr.child_by_field_name("name")
            if prop is None or prop.text.decode() not in _CS_HTTP_REQUEST_MEMBERS:
                continue

            node_line = node.start_point[0] + 1
            caller: LexicalNode | None = None
            for fn in scoped_fns:
                if fn.line_start <= node_line <= (fn.line_end or node_line) and (
                    caller is None or fn.line_start > caller.line_start
                ):
                    caller = fn
            if caller is None:
                continue

            prop_name = prop.text.decode()
            _emit(f"aspnetcore.Request.{prop_name}", caller.name, caller.node_id, node_line)

        return nodes, edges


# Auto-register when this module is imported
from . import register_language  # noqa: E402

register_language("csharp", CSharpParser, frozenset({".cs"}))
