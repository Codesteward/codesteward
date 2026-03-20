"""Scala parser (tree-sitter AST). Requires ``tree-sitter-scala`` (install with ``uv pip install -e '.[graph-scala]'``).
"""

from typing import Any

import structlog

from ._ast_utils import TreeSitterBase, _walk
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult

log = structlog.get_logger()

# Play Framework request body accessor method names.
# request.body.asJson, request.body.asText, etc.
_SCALA_PLAY_BODY_METHODS: frozenset[str] = frozenset({
    "asJson", "asText", "asXml", "asMultipartFormData",
    "asFormUrlEncoded", "asRaw",
})

# Play Framework direct request accessor methods.
_SCALA_PLAY_REQUEST_METHODS: frozenset[str] = frozenset({
    "queryString", "getQueryString", "headers", "cookies",
    "session", "flash", "contentType", "body",
    # form binding
    "bindFromRequest",
})

# Akka HTTP / Pekko HTTP route directive names that extract HTTP input.
_SCALA_AKKA_DIRECTIVES: frozenset[str] = frozenset({
    "parameters", "parameter", "entity", "formField", "formFields",
    "headerValueByName", "optionalHeaderValueByName", "cookie",
    "optionalCookie", "path", "pathPrefix", "pathEnd",
    "rawPathPrefix",
})

# ZIO HTTP / http4s: request accessor patterns (method names on request objects).
_SCALA_ZIO_REQUEST_METHODS: frozenset[str] = frozenset({
    "url", "body", "headers", "method",
})

_KEYWORDS = frozenset({
    "if", "else", "for", "while", "do", "match", "case", "return", "throw",
    "try", "catch", "finally", "new", "this", "super", "null", "true", "false",
    "import", "package", "object", "class", "trait", "extends", "with",
    "def", "val", "var", "type", "lazy", "override", "abstract", "sealed",
    "final", "private", "protected", "implicit", "explicit", "given", "using",
    "yield", "forSome", "macro", "enum", "derives", "opaque",
})


class ScalaParser(TreeSitterBase, LanguageParser):
    """Tree-sitter-based Scala parser.

    Extracts IMPORTS, CALLS, EXTENDS (incl. `with` mixins), GUARDED_BY,
    and parameter metadata.
    """

    _CLASS_TYPES = frozenset({
        "class_definition", "trait_definition", "object_definition",
    })

    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "scala",
    ) -> "ParseResult":
        parser = self._get_ts_parser("scala")
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
            self._extract_sc_nodes(root, file_path, tenant_id, repo_id, language)
        )
        class_nodes = [n for n in result.nodes if n.node_type == "class"]
        result.edges.extend(
            self._extract_sc_extends(root, class_nodes, file_path, tenant_id, repo_id)
        )
        result.edges.extend(
            self._extract_sc_imports(root, file_node.node_id, file_path, tenant_id, repo_id)
        )
        result.edges.extend(
            self._extract_sc_guarded_by(root, result.nodes, file_path, tenant_id, repo_id)
        )

        fn_nodes = [n for n in result.nodes if n.node_type == "function"]
        result.edges.extend(
            self._extract_call_edges(root, fn_nodes, file_path, tenant_id, repo_id, language)
        )
        self._extract_sc_parameters(root, fn_nodes)

        # Taint source nodes and edges (Play / Akka HTTP / ZIO HTTP / http4s)
        taint_nodes, taint_edges = self._extract_scala_taint_sources(
            root, fn_nodes, file_path, tenant_id, repo_id, language
        )
        result.nodes.extend(taint_nodes)
        result.edges.extend(taint_edges)

        return result

    # ------------------------------------------------------------------
    # Node extraction
    # ------------------------------------------------------------------

    def _extract_sc_nodes(
        self,
        root: object,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> "list[LexicalNode]":
        nodes: list[LexicalNode] = []
        for node in _walk(root):
            if node.type in self._CLASS_TYPES:
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

                # EXTENDS edges extracted separately by _extract_sc_extends()

            elif node.type == "function_definition":
                name_node = next(
                    (c for c in node.children if c.type == "identifier"), None
                )
                if name_node is None:
                    continue
                name = name_node.text.decode()
                if name in _KEYWORDS:
                    continue
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

    # ------------------------------------------------------------------
    # EXTENDS extraction
    # ------------------------------------------------------------------

    def _extract_sc_extends(
        self,
        root: object,
        class_nodes: "list[LexicalNode]",
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> "list[GraphEdge]":
        """Emit EXTENDS edges from extends_clause (includes `with` mixins)."""
        name_to_node = {n.name: n for n in class_nodes}
        edges: list[GraphEdge] = []
        for node in _walk(root):
            if node.type not in self._CLASS_TYPES:
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
                if child.type == "extends_clause":
                    for type_id in child.children:
                        if type_id.type == "type_identifier":
                            base = type_id.text.decode()
                            if base not in _KEYWORDS:
                                edges.append(GraphEdge(
                                    edge_id=GraphEdge.make_id(
                                        src.node_id, "extends", base
                                    ),
                                    edge_type="extends",
                                    source_id=src.node_id,
                                    target_id=base,
                                    target_name=base,
                                    file=file_path,
                                    line=node.start_point[0] + 1,
                                    tenant_id=tenant_id,
                                    repo_id=repo_id,
                                ))
        return edges

    # ------------------------------------------------------------------
    # Import extraction
    # ------------------------------------------------------------------

    def _extract_sc_imports(
        self,
        root: object,
        file_node_id: str,
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> "list[GraphEdge]":
        edges: list[GraphEdge] = []
        for node in _walk(root):
            if node.type != "import_declaration":
                continue
            # Collect path identifiers (field name "path")
            parts: list[str] = []
            for i in range(node.child_count):
                child = node.children[i]
                field = node.field_name_for_child(i)
                if field == "path" and child.type == "identifier":
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
    # GUARDED_BY extraction (Scala annotations)
    # ------------------------------------------------------------------

    def _extract_sc_guarded_by(
        self,
        root: object,
        nodes: "list[LexicalNode]",
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> "list[GraphEdge]":
        """Emit GUARDED_BY for @annotation on class and function definitions."""
        node_map = {n.name: n for n in nodes if n.node_type in ("function", "class")}
        edges: list[GraphEdge] = []

        for decl in _walk(root):
            if decl.type not in self._CLASS_TYPES | {"function_definition"}:
                continue
            name_node = next(
                (c for c in decl.children if c.type == "identifier"), None
            )
            if name_node is None:
                continue
            target = node_map.get(name_node.text.decode())
            if target is None:
                continue

            for child in decl.children:
                if child.type != "annotation":
                    continue
                # annotation → name field (type_identifier) or direct type_identifier child
                annot_name_node = child.child_by_field_name("name") or next(
                    (c for c in child.children if c.type == "type_identifier"), None
                )
                if annot_name_node is None:
                    continue
                annot_name = annot_name_node.text.decode()
                edges.append(GraphEdge(
                    edge_id=GraphEdge.make_id(target.node_id, "guarded_by", annot_name),
                    edge_type="guarded_by",
                    source_id=target.node_id,
                    target_id=annot_name,
                    target_name=annot_name,
                    file=file_path,
                    line=decl.start_point[0] + 1,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))

        return edges

    # ------------------------------------------------------------------
    # Parameter extraction
    # ------------------------------------------------------------------

    def _extract_sc_parameters(
        self,
        root: object,
        fn_nodes: "list[LexicalNode]",
    ) -> None:
        """Populate ``metadata['parameters']`` on function nodes in-place."""
        fn_map = {n.name: n for n in fn_nodes}
        for node in _walk(root):
            if node.type != "function_definition":
                continue
            name_node = next(
                (c for c in node.children if c.type == "identifier"), None
            )
            if name_node is None:
                continue
            fn = fn_map.get(name_node.text.decode())
            if fn is None:
                continue
            params: list[dict[str, Any]] = []
            for child in node.children:
                if child.type != "parameters":
                    continue
                for p in child.children:
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
    # Taint source emission (Play / Akka HTTP / ZIO HTTP / http4s)
    # ------------------------------------------------------------------

    def _extract_scala_taint_sources(
        self,
        root: object,
        fn_nodes: "list[LexicalNode]",
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> "tuple[list[LexicalNode], list[GraphEdge]]":
        """Emit taint-source nodes and CALLS edges for Scala HTTP input patterns.

        Detects three frameworks:

        1. **Play Framework** — ``request.body.asJson``, ``request.body.asText``,
           ``request.queryString``, ``request.getQueryString("name")``,
           ``form.bindFromRequest()``, etc.  Detected by finding identifiers named
           ``request`` followed by field access or method calls in
           ``_SCALA_PLAY_BODY_METHODS`` / ``_SCALA_PLAY_REQUEST_METHODS``.

        2. **Akka HTTP / Pekko HTTP** — route directives such as
           ``parameters("name")``, ``entity(as[T])``, ``formField("f")``,
           ``headerValueByName("h")``, ``cookie("c")`` etc.  Detected as
           function calls whose callee matches ``_SCALA_AKKA_DIRECTIVES``.

        3. **ZIO HTTP / http4s** — ``request.url``, ``request.body``,
           ``request.headers`` accessed as fields on common request variable names.

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

        def _emit(source_name: str, caller: "LexicalNode", line: int) -> None:
            source_id = LexicalNode.make_id(
                tenant_id, repo_id, "scala_http", source_name, "external"
            )
            if source_id not in seen_nodes:
                seen_nodes.add(source_id)
                nodes.append(LexicalNode(
                    node_id=source_id,
                    node_type="external",
                    name=source_name,
                    file="scala_http",
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
                    line=line,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))

        _play_all = _SCALA_PLAY_BODY_METHODS | _SCALA_PLAY_REQUEST_METHODS

        for node in _walk(root):
            node_type: str = node.type

            if node_type == "call_expression":
                # Extract callee text (tree-sitter-scala uses "function" field or first child)
                fn_field = node.child_by_field_name("function") or next(
                    (c for c in node.children
                     if c.type in ("field_expression", "identifier", "select_expression")),
                    None,
                )
                if fn_field is None:
                    continue
                fn_text = fn_field.text.decode()

                # ── Akka HTTP directives (bare function calls) ────────────────
                # e.g. parameters("name"), entity(as[T])
                callee_bare = fn_text.split(".")[-1]
                if callee_bare in _SCALA_AKKA_DIRECTIVES:
                    node_line = node.start_point[0] + 1
                    caller = _find_caller(node_line)
                    if caller:
                        _emit(f"scala_http.akka.{callee_bare}", caller, node_line)
                    continue

                # ── Play request method calls ─────────────────────────────────
                # e.g. request.getQueryString("name"), form.bindFromRequest()
                parts = fn_text.split(".")
                if (len(parts) >= 2
                        and parts[-2] in ("request", "req", "form")
                        and parts[-1] in _play_all):
                    node_line = node.start_point[0] + 1
                    caller = _find_caller(node_line)
                    if caller:
                        _emit(f"scala_http.play.{parts[-1]}", caller, node_line)

            elif node_type == "field_expression":
                # ── Play / ZIO field access: request.body, request.queryString ─
                # e.g. request.body.asJson → two-level; detect both levels
                value_node = node.child_by_field_name("value")
                field_node = node.child_by_field_name("field")
                if value_node is None or field_node is None:
                    continue
                field_name = field_node.text.decode()

                # Check inner object text for "request" or "req"
                value_text = value_node.text.decode()
                is_request_chain = (
                    value_text in ("request", "req")
                    or value_text.endswith(".request")
                    or value_text.endswith(".req")
                    or "request.body" in value_text  # body.asJson level
                )
                if not is_request_chain:
                    continue

                if field_name in _SCALA_PLAY_BODY_METHODS | _SCALA_PLAY_REQUEST_METHODS | _SCALA_ZIO_REQUEST_METHODS:
                    node_line = node.start_point[0] + 1
                    caller = _find_caller(node_line)
                    if caller:
                        _emit(f"scala_http.play.{field_name}", caller, node_line)

        return nodes, edges


from . import register_language  # noqa: E402

register_language("scala", ScalaParser, frozenset({".scala"}))
