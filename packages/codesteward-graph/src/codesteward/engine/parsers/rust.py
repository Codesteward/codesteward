"""Rust parser (tree-sitter AST). Requires ``tree-sitter-rust`` (install with ``uv pip install -e '.[graph-rust]'``).
"""

from typing import Any

import structlog

from ._ast_utils import TreeSitterBase, _walk
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult

log = structlog.get_logger()

# Actix-web / Axum / Rocket extractor type name components.
# Scoped forms (web::Path, web::Json, ...) are checked as substrings of the type text.
_RUST_SCOPED_EXTRACTORS: frozenset[str] = frozenset({
    # Actix-web
    "web::Path", "web::Query", "web::Json", "web::Form", "web::Bytes", "web::Multipart",
    # Axum (fully qualified)
    "extract::Path", "extract::Query", "extract::Json", "extract::Form",
    "extract::Bytes", "extract::Multipart",
})

# Bare type names that are treated as extractors only when used in generic form
# (i.e. the type text starts with one of these followed by '<'), which strongly
# implies an Actix-web / Axum extractor rather than an unrelated `Path` type.
_RUST_GENERIC_EXTRACTORS: frozenset[str] = frozenset({
    "Path", "Query", "Json", "Form", "Bytes", "Multipart",
})

# Bare type names that are always treated as extractors regardless of generics.
_RUST_BARE_EXTRACTORS: frozenset[str] = frozenset({
    "HttpRequest",   # Actix-web
    "TypedHeader",   # Axum
    "HeaderMap",     # Axum / Hyper
})

_KEYWORDS = frozenset({
    "if", "else", "for", "while", "loop", "match", "return", "break",
    "continue", "let", "const", "static", "fn", "struct", "enum", "trait",
    "impl", "mod", "use", "pub", "self", "super", "crate", "type", "where",
    "async", "await", "move", "dyn", "unsafe", "extern", "ref", "mut",
})


class RustParser(TreeSitterBase, LanguageParser):
    """Tree-sitter-based Rust parser.

    Extracts IMPORTS (use declarations), CALLS, GUARDED_BY (#[attributes]),
    PROTECTED_BY (Actix-web web::scope().wrap().route() chains), and
    struct/trait/enum/function nodes.
    Rust has no class inheritance — EXTENDS edges are not emitted.
    """

    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "rust",
    ) -> ParseResult:
        """Parse a Rust source file and return its graph representation.

        Args:
            file_path: Repo-relative path to the file.
            content: Full file content as a string.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Always "rust".

        Returns:
            ParseResult with the file node, symbol nodes, and edges.
        """
        parser = self._get_ts_parser("rust")
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

        result.nodes.extend(self._extract_rust_nodes(root, file_path, tenant_id, repo_id, language))
        result.edges.extend(
            self._extract_rust_imports(root, file_node.node_id, file_path, tenant_id, repo_id)
        )
        result.edges.extend(
            self._extract_rust_guarded_by(root, result.nodes, file_path, tenant_id, repo_id)
        )
        fn_nodes = [n for n in result.nodes if n.node_type == "function"]
        result.edges.extend(
            self._extract_call_edges(root, fn_nodes, file_path, tenant_id, repo_id, language)
        )
        # PROTECTED_BY edges (Actix-web scope+wrap+route chains)
        result.edges.extend(
            self._extract_rust_protected_by(
                root, fn_nodes, result.nodes, file_path, tenant_id, repo_id
            )
        )

        # Taint source nodes (Actix-web / Axum / Rocket extractor parameters)
        taint_nodes, taint_edges = self._extract_rust_taint_sources(
            root, fn_nodes, file_path, tenant_id, repo_id, language
        )
        result.nodes.extend(taint_nodes)
        result.edges.extend(taint_edges)

        return result

    def _extract_rust_nodes(
        self,
        root: object,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> list[LexicalNode]:
        """Extract struct, trait, enum, and function nodes from Rust source.

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
            if node.type in ("struct_item", "trait_item", "enum_item"):
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
            elif node.type == "function_item":
                name_node = node.child_by_field_name("name")
                if name_node and name_node.text.decode() not in _KEYWORDS:
                    # `async` appears inside a `function_modifiers` child node
                    is_async = any(
                        c.type == "function_modifiers" and any(
                            m.type == "async" for m in c.children
                        )
                        for c in node.children
                    )
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
                        is_async=is_async,
                    ))
        return nodes

    def _extract_rust_imports(
        self,
        root: object,
        file_node_id: str,
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Extract use declarations as import edges.

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
            if node.type != "use_declaration":
                continue
            arg = node.child_by_field_name("argument")
            if arg is None:
                continue
            module = arg.text.decode().rstrip(";")
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

    def _extract_rust_guarded_by(
        self,
        root: object,
        nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Emit GUARDED_BY edges for #[attribute] items preceding struct/fn definitions.

        Args:
            root: AST root node.
            nodes: All LexicalNodes extracted from this file.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of guarded_by GraphEdge objects.
        """
        # Build a map of line_start → node for fast lookup
        line_to_node: dict[int, LexicalNode] = {}
        for n in nodes:
            line_to_node[n.line_start] = n

        edges: list[GraphEdge] = []
        seen: set[str] = set()

        # attribute_item immediately precedes its target node in the AST children
        # Walk parent-level children looking for (attribute_item*, struct/fn)
        def _process_children(children: list[Any]) -> None:
            pending_attrs: list[str] = []
            for child in children:
                if child.type == "attribute_item":
                    # Extract identifier from #[name] or #[name(...)]
                    attr_name = self._rust_attr_name(child)
                    if attr_name:
                        pending_attrs.append(attr_name)
                elif child.type in (
                    "struct_item", "trait_item", "enum_item", "function_item", "impl_item"
                ):
                    if child.type != "impl_item":
                        src = line_to_node.get(child.start_point[0] + 1)
                        if src:
                            for attr in pending_attrs:
                                key = f"{src.node_id}:{attr}"
                                if key not in seen:
                                    seen.add(key)
                                    edges.append(GraphEdge(
                                        edge_id=GraphEdge.make_id(src.node_id, "guarded_by", attr),
                                        edge_type="guarded_by",
                                        source_id=src.node_id,
                                        target_id=attr,
                                        target_name=attr,
                                        file=file_path,
                                        line=child.start_point[0] + 1,
                                        tenant_id=tenant_id,
                                        repo_id=repo_id,
                                    ))
                    # Recurse into impl_item body to handle method-level attributes
                    body = child.child_by_field_name("body")
                    if body:
                        _process_children(body.children)
                    pending_attrs.clear()
                else:
                    pending_attrs.clear()

        _process_children(root.children)  # type: ignore[attr-defined]
        return edges

    def _rust_attr_name(self, attr_item_node: object) -> str | None:
        """Extract the attribute name from a Rust ``attribute_item`` node.

        Args:
            attr_item_node: An attribute_item AST node.

        Returns:
            Attribute name string, or None if unresolvable.
        """
        for child in attr_item_node.children:  # type: ignore[attr-defined]
            if child.type == "attribute":
                # attribute node: first identifier child is the name
                for inner in child.children:
                    if inner.type == "identifier":
                        return str(inner.text.decode())
                    if inner.type == "scoped_identifier":
                        name_node = inner.child_by_field_name("name")
                        return str(name_node.text.decode()) if name_node else None
        return None

    # ------------------------------------------------------------------
    # PROTECTED_BY extraction (Actix-web scope+wrap+route chains)
    # ------------------------------------------------------------------

    def _extract_rust_protected_by(
        self,
        root: object,
        fn_nodes: list[LexicalNode],
        result_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Emit PROTECTED_BY edges for Actix-web ``web::scope().wrap().route()`` chains.

        Detects::

            web::scope("/api")
                .wrap(auth_middleware)
                .route("/profile", web::get().to(get_profile))

        For each ``.route()`` or ``.service()`` call, walks the method chain upward
        to find ``.wrap(middleware)`` and extracts the handler from ``.to(handler)``.

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
        _ROUTE_METHODS = frozenset({"route", "service"})

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
            if node.type != "call_expression":
                continue
            fn_field = node.child_by_field_name("function")
            if fn_field is None or fn_field.type != "field_expression":
                continue
            method_node = fn_field.child_by_field_name("field")
            if method_node is None or method_node.text.decode() not in _ROUTE_METHODS:
                continue

            # Extract handler name from .to(handler) inside the route arguments
            handler_name = self._actix_extract_handler(node)
            if not handler_name:
                continue

            # Walk the chain upward from the receiver of .route() to find .wrap()
            chain = fn_field.child_by_field_name("value")
            middlewares = self._actix_find_wrap(chain)
            if not middlewares:
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
                    language="rust",
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                )
                result_nodes.append(src)
                fn_name_to_node[handler_name] = src

            for mw in middlewares:
                _emit(src.node_id, mw, node.start_point[0] + 1)

        return edges

    def _actix_extract_handler(self, route_call: object) -> str | None:
        """Extract the handler function name from an Actix-web ``.route()`` call.

        Looks for a ``.to(handler_fn)`` call in the route's arguments.

        Args:
            route_call: A ``call_expression`` AST node for the ``.route()`` call.

        Returns:
            Handler function name, or None if not found.
        """
        args_node = route_call.child_by_field_name("arguments")  # type: ignore[attr-defined]
        if args_node is None:
            return None
        for arg in _walk(args_node):
            if arg.type != "call_expression":
                continue
            fn_f = arg.child_by_field_name("function")
            if fn_f is None or fn_f.type != "field_expression":
                continue
            fld = fn_f.child_by_field_name("field")
            if fld is None or fld.text.decode() != "to":
                continue
            inner_args = arg.child_by_field_name("arguments")
            if inner_args is None:
                continue
            for a in inner_args.children:
                if a.type == "identifier":
                    return str(a.text.decode())
        return None

    def _actix_find_wrap(self, chain_node: object) -> list[str]:
        """Walk an Actix-web method chain and collect ``.wrap(fn)`` middleware names.

        Iterates up the chain by following ``field_expression.value`` at each level
        until a non-chain node is reached.

        Args:
            chain_node: Starting node in the method call chain (receiver of ``.route()``).

        Returns:
            List of middleware names found in ``.wrap()`` calls.
        """
        middlewares: list[str] = []
        node = chain_node
        while node is not None:
            if node.type != "call_expression":  # type: ignore[attr-defined]
                break
            fn_f = node.child_by_field_name("function")
            if fn_f is None or fn_f.type != "field_expression":
                break
            fld = fn_f.child_by_field_name("field")
            if fld and fld.text.decode() == "wrap":
                args = node.child_by_field_name("arguments")
                if args:
                    for a in args.children:
                        if a.type == "identifier":
                            middlewares.append(a.text.decode())
            node = fn_f.child_by_field_name("value")
        return middlewares


    # ------------------------------------------------------------------
    # Taint source emission (Actix-web / Axum / Rocket extractor parameters)
    # ------------------------------------------------------------------

    def _extract_rust_taint_sources(
        self,
        root: object,
        fn_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> tuple[list[LexicalNode], list[GraphEdge]]:
        """Emit taint-source nodes and CALLS edges for Rust web framework extractors.

        Rust web frameworks (Actix-web, Axum, Rocket) express HTTP input binding
        through typed function parameters called *extractors*.  A route handler
        like::

            async fn get_user(
                path: web::Path<u64>,
                query: web::Query<Filter>,
                body: web::Json<CreateUser>,
            ) -> impl Responder { ... }

        receives request data through those typed parameters.  The parser detects
        parameters whose type text matches known extractor names and emits a
        synthetic ``LexicalNode`` with ``file="actix_axum"`` for each matched
        extractor category (``Path``, ``Query``, ``Json``, ``Form``, ``Bytes``,
        etc.), plus a ``CALLS`` edge to the handler function.

        Detection rules (applied to the full type text of each parameter):

        - Scoped extractors — type contains ``web::Path``, ``extract::Json``, etc.
        - Generic bare extractors — type starts with ``Path<``, ``Query<``, etc.
        - Bare non-generic extractors — type is exactly ``HttpRequest``,
          ``TypedHeader``, or ``HeaderMap``.

        Non-taint parameters (``web::Data``, ``Extension``, ``State``) are
        excluded by these rules (they have no entry in the detection sets).

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

        fn_id_by_name: dict[str, LexicalNode] = {n.name: n for n in fn_nodes}

        def _emit(source_name: str, handler: LexicalNode, line: int) -> None:
            source_id = LexicalNode.make_id(
                tenant_id, repo_id, "actix_axum", source_name, "external"
            )
            if source_id not in seen_nodes:
                seen_nodes.add(source_id)
                nodes.append(LexicalNode(
                    node_id=source_id,
                    node_type="external",
                    name=source_name,
                    file="actix_axum",
                    line_start=1,
                    line_end=1,
                    language=language,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))
            edge_key = f"{source_id}:{handler.node_id}"
            if edge_key not in seen_edges:
                seen_edges.add(edge_key)
                edges.append(GraphEdge(
                    edge_id=GraphEdge.make_id(source_id, "calls", handler.name),
                    edge_type="calls",
                    source_id=source_id,
                    target_id=handler.node_id,
                    target_name=handler.name,
                    file=file_path,
                    line=line,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))

        def _extractor_name(type_text: str) -> str | None:
            """Return the canonical extractor name for a type string, or None."""
            # Scoped: web::Path<T>, extract::Json<T>, etc.
            for scoped in _RUST_SCOPED_EXTRACTORS:
                if scoped in type_text:
                    return scoped.split("::")[-1]
            # Bare non-generic: HttpRequest, TypedHeader, HeaderMap
            stripped = type_text.strip().lstrip("&").strip()
            if stripped in _RUST_BARE_EXTRACTORS:
                return stripped
            # Generic bare: Path<T>, Query<T>, etc. (avoids matching plain `Path`)
            for bare in _RUST_GENERIC_EXTRACTORS:
                if type_text.strip().startswith(f"{bare}<"):
                    return bare
            return None

        for node in _walk(root):
            if node.type != "function_item":
                continue
            name_node = node.child_by_field_name("name")
            if name_node is None:
                continue
            fn_name = name_node.text.decode()
            handler = fn_id_by_name.get(fn_name)
            if handler is None:
                continue

            params_node = node.child_by_field_name("parameters")
            if params_node is None:
                continue

            for param in params_node.children:
                if param.type != "parameter":
                    continue
                type_node = param.child_by_field_name("type")
                if type_node is None:
                    continue
                type_text = type_node.text.decode()
                extractor = _extractor_name(type_text)
                if extractor:
                    _emit(f"actix_axum.{extractor}", handler, param.start_point[0] + 1)

        return nodes, edges


from . import register_language  # noqa: E402

register_language("rust", RustParser, frozenset({".rs"}))
