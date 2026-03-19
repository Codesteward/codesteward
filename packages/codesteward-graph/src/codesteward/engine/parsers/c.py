"""C parser (tree-sitter AST). Requires ``tree-sitter-c`` (install with ``uv pip install -e '.[graph-c]'``).
"""

import structlog

from ._ast_utils import TreeSitterBase, _strip_quotes, _walk
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult

# CGI / POSIX environment variables that carry HTTP request data.
# Accessed via getenv("QUERY_STRING") in CGI programs.
_C_CGI_HTTP_ENV_VARS: frozenset[str] = frozenset({
    "QUERY_STRING", "REQUEST_METHOD", "CONTENT_TYPE", "CONTENT_LENGTH",
    "HTTP_COOKIE", "HTTP_AUTHORIZATION", "HTTP_HOST", "HTTP_USER_AGENT",
    "PATH_INFO", "PATH_TRANSLATED", "SCRIPT_NAME", "SERVER_NAME",
    "REQUEST_URI",
})

# C function names that read untrusted HTTP data.
# Covers CGI (getenv, fread from stdin), Mongoose, libmicrohttpd, and similar.
_C_HTTP_SOURCE_FUNCTIONS: frozenset[str] = frozenset({
    # CGI
    "getenv",
    # Mongoose (older API uses mg_get_http_var / mg_http_get_var; newer uses mg_http_message fields)
    "mg_get_http_var", "mg_http_get_var", "mg_http_get_header",
    # libmicrohttpd
    "MHD_lookup_connection_value",
    # Generic read from stdin (POST body in CGI)
    "fread", "fgets", "read",
})

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
    if decl_node.type == "function_declarator":  # type: ignore[attr-defined]
        inner = decl_node.child_by_field_name("declarator")  # type: ignore[attr-defined]
        if inner is None:
            return None
        if inner.type in ("identifier", "field_identifier"):
            return str(inner.text.decode())
        # Recurse for pointer_declarator wrapping
        return _c_function_name(inner)
    if decl_node.type == "pointer_declarator":  # type: ignore[attr-defined]
        inner = decl_node.child_by_field_name("declarator")  # type: ignore[attr-defined]
        return _c_function_name(inner)
    if decl_node.type in ("identifier", "field_identifier"):  # type: ignore[attr-defined]
        return str(decl_node.text.decode())  # type: ignore[attr-defined]
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

        # Taint source nodes and edges (CGI / Mongoose / libmicrohttpd)
        taint_nodes, taint_edges = self._extract_c_taint_sources(
            root, fn_nodes, file_path, tenant_id, repo_id, language
        )
        result.nodes.extend(taint_nodes)
        result.edges.extend(taint_edges)

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


    def _extract_c_taint_sources(
        self,
        root: object,
        fn_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> tuple[list[LexicalNode], list[GraphEdge]]:
        """Emit taint-source nodes and CALLS edges for C HTTP input patterns.

        Detects CGI programs, Mongoose, and libmicrohttpd:

        - **CGI** — ``getenv("QUERY_STRING")``, ``getenv("HTTP_COOKIE")``, etc.
          Only ``getenv`` calls whose first string argument matches a known HTTP
          environment variable name emit a taint source.  ``fread(buf, 1, n, stdin)``
          and ``read(STDIN_FILENO, ...)`` are also detected (POST body).

        - **Mongoose** — ``mg_http_get_var()``, ``mg_http_get_header()``,
          ``mg_get_http_var()`` function calls.

        - **libmicrohttpd** — ``MHD_lookup_connection_value()`` calls.

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
            source_id = LexicalNode.make_id(tenant_id, repo_id, "c_http", source_name, "external")
            if source_id not in seen_nodes:
                seen_nodes.add(source_id)
                nodes.append(LexicalNode(
                    node_id=source_id,
                    node_type="external",
                    name=source_name,
                    file="c_http",
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
            if node.type != "call_expression":
                continue
            fn_field = node.child_by_field_name("function")
            if fn_field is None:
                continue
            fn_name = fn_field.text.decode()
            if fn_name not in _C_HTTP_SOURCE_FUNCTIONS:
                continue

            node_line = node.start_point[0] + 1
            caller = _find_caller(node_line)
            if caller is None:
                continue

            if fn_name == "getenv":
                # Only emit for known HTTP env vars to avoid false positives.
                args = node.child_by_field_name("arguments")
                if args is None:
                    continue
                for arg in args.children:
                    if arg.type in ("string_literal", "string"):
                        env_var = _strip_quotes(arg.text.decode())
                        if env_var in _C_CGI_HTTP_ENV_VARS:
                            _emit(f"c_http.cgi.{env_var}", caller, node_line)
                        break
            elif fn_name in ("fread", "fgets", "read"):
                # Only emit when reading from stdin (CGI POST body).
                args = node.child_by_field_name("arguments")
                if args is None:
                    continue
                args_text = args.text.decode()
                if "stdin" in args_text or "STDIN_FILENO" in args_text:
                    _emit("c_http.cgi.stdin", caller, node_line)
            else:
                # Mongoose / libmicrohttpd — always a taint source.
                _emit(f"c_http.{fn_name}", caller, node_line)

        return nodes, edges


from . import register_language  # noqa: E402

register_language("c", CParser, frozenset({".c", ".h"}))
