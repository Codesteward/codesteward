"""C++ parser (tree-sitter AST). Requires ``tree-sitter-cpp`` (install with ``uv pip install -e '.[graph-cpp]'``).
"""

import structlog

from ._ast_utils import TreeSitterBase, _strip_quotes, _walk
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult
from .c import _C_CGI_HTTP_ENV_VARS, _C_HTTP_SOURCE_FUNCTIONS, _c_function_name  # reuse helpers

# Crow / Drogon / Pistache: method names on request objects that expose HTTP input.
# req.body, req.url_params, req.headers (Crow); req->getBody(), req->getParameter() (Drogon)
_CPP_HTTP_REQUEST_MEMBERS: frozenset[str] = frozenset({
    # Crow (request object fields and methods)
    "body", "url_params", "headers",
    # Drogon (HttpRequestPtr methods)
    "getBody", "getParameter", "getParameters", "getHeader", "getHeaders",
    "getCookie", "getCookies", "getJsonBody", "getJsonObject",
    "getPath", "getQuery",
    # Pistache
    "query", "resource",
    # Generic / Oat++ (oatpp)
    "getPathVariable", "getQueryParameter", "readBodyToString",
    "readBodyToDto",
})

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

        # Taint source nodes and edges (CGI + Crow + Drogon + Pistache)
        taint_nodes, taint_edges = self._extract_cpp_taint_sources(
            root, fn_nodes, file_path, tenant_id, repo_id, language
        )
        result.nodes.extend(taint_nodes)
        result.edges.extend(taint_edges)

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


    def _extract_cpp_taint_sources(
        self,
        root: object,
        fn_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> tuple[list[LexicalNode], list[GraphEdge]]:
        """Emit taint-source nodes and CALLS edges for C++ HTTP input patterns.

        Detects three categories:

        1. **CGI** — same as the C parser: ``getenv("QUERY_STRING")``,
           ``fread(buf, 1, n, stdin)``, Mongoose / libmicrohttpd functions.
           Reuses the ``_C_HTTP_SOURCE_FUNCTIONS`` and ``_C_CGI_HTTP_ENV_VARS``
           constants from the C parser.

        2. **Crow framework** — field access on request objects:
           ``req.body``, ``req.url_params``, ``req.headers``.
           Detected via ``field_expression`` where the field name is in
           ``_CPP_HTTP_REQUEST_MEMBERS``.

        3. **Drogon / Pistache / Oat++** — method calls on request pointer/objects:
           ``req->getBody()``, ``req->getParameter("name")``,
           ``req->getHeader("name")``, ``req->getCookie("name")``, etc.
           Detected via ``call_expression`` where the callee is a
           ``field_expression`` (pointer or member call) with a field name
           in ``_CPP_HTTP_REQUEST_MEMBERS``.

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

        def _find_caller(line: int) -> LexicalNode | None:
            caller: LexicalNode | None = None
            for fn in scoped_fns:
                if fn.line_start <= line <= (fn.line_end or line) and (
                    caller is None or fn.line_start > caller.line_start
                ):
                    caller = fn
            return caller

        def _emit(source_name: str, caller: LexicalNode, line: int) -> None:
            source_id = LexicalNode.make_id(tenant_id, repo_id, "cpp_http", source_name, "external")
            if source_id not in seen_nodes:
                seen_nodes.add(source_id)
                nodes.append(LexicalNode(
                    node_id=source_id,
                    node_type="external",
                    name=source_name,
                    file="cpp_http",
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

        for node in _walk(root):
            node_type: str = node.type

            if node_type == "call_expression":
                fn_field = node.child_by_field_name("function")
                if fn_field is None:
                    continue

                # ── CGI / Mongoose / libmicrohttpd (same as C) ───────────────
                if fn_field.type == "identifier":
                    fn_name = fn_field.text.decode()
                    if fn_name in _C_HTTP_SOURCE_FUNCTIONS:
                        node_line = node.start_point[0] + 1
                        caller = _find_caller(node_line)
                        if caller is None:
                            continue
                        if fn_name == "getenv":
                            args = node.child_by_field_name("arguments")
                            if args:
                                for arg in args.children:
                                    if arg.type in ("string_literal", "string"):
                                        env_var = _strip_quotes(arg.text.decode())
                                        if env_var in _C_CGI_HTTP_ENV_VARS:
                                            _emit(f"cpp_http.cgi.{env_var}", caller, node_line)
                                        break
                        elif fn_name in ("fread", "fgets", "read"):
                            args = node.child_by_field_name("arguments")
                            if args and ("stdin" in args.text.decode() or "STDIN_FILENO" in args.text.decode()):
                                _emit("cpp_http.cgi.stdin", caller, node_line)
                        else:
                            _emit(f"cpp_http.{fn_name}", caller, node_line)
                    continue

                # ── Drogon req->getBody() / req->getParameter() ──────────────
                if fn_field.type == "field_expression":
                    field_id = fn_field.child_by_field_name("field")
                    if field_id and field_id.text.decode() in _CPP_HTTP_REQUEST_MEMBERS:
                        node_line = node.start_point[0] + 1
                        caller = _find_caller(node_line)
                        if caller:
                            method_name = field_id.text.decode()
                            _emit(f"cpp_http.{method_name}", caller, node_line)

            elif node_type == "field_expression":
                # ── Crow req.body / req.url_params / req.headers ─────────────
                field_id = node.child_by_field_name("field")
                if field_id and field_id.text.decode() in _CPP_HTTP_REQUEST_MEMBERS:
                    node_line = node.start_point[0] + 1
                    caller = _find_caller(node_line)
                    if caller:
                        field_name = field_id.text.decode()
                        _emit(f"cpp_http.{field_name}", caller, node_line)

        return nodes, edges


from . import register_language  # noqa: E402

register_language("cpp", CppParser, frozenset({".cpp", ".cxx", ".cc", ".hpp", ".hxx"}))
