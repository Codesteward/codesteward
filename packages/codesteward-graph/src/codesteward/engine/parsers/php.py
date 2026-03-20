"""PHP parser (tree-sitter AST). Requires ``tree-sitter-php`` (install with ``uv pip install -e '.[graph-php]'``).
"""

import structlog

from ._ast_utils import _BUILTIN_NAMES, TreeSitterBase, _walk
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult

# PHP superglobal variables that carry untrusted HTTP input.
_PHP_SUPERGLOBALS: frozenset[str] = frozenset({
    "$_GET", "$_POST", "$_REQUEST", "$_FILES", "$_COOKIE", "$_SERVER",
})

# Laravel Illuminate\Http\Request input methods that expose HTTP data.
_PHP_LARAVEL_INPUT_METHODS: frozenset[str] = frozenset({
    "input", "query", "post", "get", "all", "json", "file", "files",
    "only", "except", "collect", "filled", "string", "integer", "boolean",
    "float", "date", "array", "getContent",
})

# Symfony ParameterBag names accessed via $request->{bag}->get(...)
# e.g. $request->query->get("name"), $request->request->get("name")
_PHP_SYMFONY_BAGS: frozenset[str] = frozenset({
    "query", "request", "files", "cookies", "headers", "server",
})

# PSR-7 / Slim request accessor methods (getQueryParams, getParsedBody, etc.)
_PHP_PSR7_METHODS: frozenset[str] = frozenset({
    "getQueryParams", "getParsedBody", "getUploadedFiles", "getCookieParams",
    "getServerParams", "getBody", "getParsedBodyParam", "getQueryParam",
    "getAttribute",
})

# CodeIgniter 4 IncomingRequest methods
_PHP_CI4_METHODS: frozenset[str] = frozenset({
    "getGet", "getPost", "getVar", "getJSON", "getRawInput", "getFile",
    "getFiles", "getHeader", "getCookie",
})

log = structlog.get_logger()

_KEYWORDS = frozenset({
    "if", "else", "elseif", "for", "foreach", "while", "do", "switch",
    "case", "return", "break", "continue", "throw", "try", "catch",
    "finally", "class", "interface", "trait", "enum", "function",
    "namespace", "use", "new", "echo", "print", "null", "true", "false",
    "static", "public", "private", "protected", "abstract", "final",
    "readonly", "self", "parent", "match",
})


class PhpParser(TreeSitterBase, LanguageParser):
    """Tree-sitter-based PHP parser.

    Extracts IMPORTS (use declarations), CALLS, EXTENDS, GUARDED_BY
    (#[Attribute] annotations), PROTECTED_BY (Laravel Route::middleware()->group()),
    and class/function/method nodes.
    """

    _CLASS_DECL_TYPES = frozenset({
        "class_declaration", "interface_declaration", "trait_declaration",
    })

    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "php",
    ) -> ParseResult:
        """Parse a PHP source file and return its graph representation.

        Args:
            file_path: Repo-relative path to the file.
            content: Full file content as a string.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Always "php".

        Returns:
            ParseResult with the file node, symbol nodes, and edges.
        """
        parser = self._get_ts_parser("php")
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

        result.nodes.extend(self._extract_php_nodes(root, file_path, tenant_id, repo_id, language))
        class_nodes = [n for n in result.nodes if n.node_type == "class"]
        result.edges.extend(
            self._extract_php_extends(root, class_nodes, file_path, tenant_id, repo_id)
        )
        result.edges.extend(
            self._extract_php_imports(root, file_node.node_id, file_path, tenant_id, repo_id)
        )
        result.edges.extend(
            self._extract_php_guarded_by(root, result.nodes, file_path, tenant_id, repo_id)
        )
        fn_nodes = [n for n in result.nodes if n.node_type == "function"]
        result.edges.extend(
            self._extract_php_call_edges(root, fn_nodes, file_path, tenant_id, repo_id)
        )
        # PROTECTED_BY edges (Laravel Route::middleware()->group() scope)
        result.edges.extend(
            self._extract_php_protected_by(
                root, fn_nodes, result.nodes, file_path, tenant_id, repo_id
            )
        )

        # Taint source nodes and edges (PHP HTTP input)
        taint_nodes, taint_edges = self._extract_php_taint_sources(
            root, fn_nodes, file_path, tenant_id, repo_id, language
        )
        result.nodes.extend(taint_nodes)
        result.edges.extend(taint_edges)

        return result

    def _extract_php_nodes(
        self,
        root: object,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> list[LexicalNode]:
        """Extract class, interface, trait, method, and function nodes.

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
            if node.type in self._CLASS_DECL_TYPES:
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
            elif node.type in ("method_declaration", "function_definition"):
                name_node = node.child_by_field_name("name")
                if name_node and name_node.text.decode() not in _KEYWORDS:
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
        return nodes

    def _extract_php_extends(
        self,
        root: object,
        class_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Emit EXTENDS edges from base_clause and class_interface_clause.

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
            if node.type not in self._CLASS_DECL_TYPES:
                continue
            name_node = node.child_by_field_name("name")
            if not name_node:
                continue
            src = name_to_node.get(name_node.text.decode())
            if not src:
                continue
            for child in node.children:
                if child.type == "base_clause":
                    # base_clause: "extends" <name>
                    for bchild in child.children:
                        if bchild.type == "name":
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
                elif child.type == "class_interface_clause":
                    # class_interface_clause: "implements" <name>, <name>, ...
                    for bchild in child.children:
                        if bchild.type == "name":
                            iface = bchild.text.decode()
                            if iface not in _KEYWORDS:
                                edges.append(GraphEdge(
                                    edge_id=GraphEdge.make_id(src.node_id, "extends", iface),
                                    edge_type="extends",
                                    source_id=src.node_id,
                                    target_id=iface,
                                    target_name=iface,
                                    file=file_path,
                                    line=node.start_point[0] + 1,
                                    tenant_id=src.tenant_id,
                                    repo_id=src.repo_id,
                                ))
        return edges

    def _extract_php_imports(
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
            if node.type != "namespace_use_declaration":
                continue
            for child in node.children:
                if child.type == "namespace_use_clause":
                    # Take the first part (full namespace path before optional alias)
                    module = child.text.decode().split(" as ")[0].strip().lstrip("\\")
                    if module and module not in seen:
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

    def _extract_php_guarded_by(
        self,
        root: object,
        nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Emit GUARDED_BY edges for PHP #[Attribute] on methods and classes.

        Args:
            root: AST root node.
            nodes: All LexicalNodes extracted from this file.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of guarded_by GraphEdge objects.
        """
        node_map = {n.name: n for n in nodes if n.node_type in ("function", "class")}
        edges: list[GraphEdge] = []
        seen: set[str] = set()

        for node in _walk(root):
            if node.type not in ("method_declaration", "function_definition",
                                 *self._CLASS_DECL_TYPES):
                continue
            name_node = node.child_by_field_name("name")
            if not name_node:
                continue
            src = node_map.get(name_node.text.decode())
            if not src:
                continue
            # attributes field on method_declaration
            attrs_node = node.child_by_field_name("attributes")
            if attrs_node:
                for attr in _walk(attrs_node):
                    if attr.type == "attribute":
                        for inner in attr.children:
                            if inner.type == "name":
                                guard = inner.text.decode()
                                key = f"{src.node_id}:{guard}"
                                if key not in seen:
                                    seen.add(key)
                                    edges.append(GraphEdge(
                                        edge_id=GraphEdge.make_id(
                                            src.node_id, "guarded_by", guard
                                        ),
                                        edge_type="guarded_by",
                                        source_id=src.node_id,
                                        target_id=guard,
                                        target_name=guard,
                                        file=file_path,
                                        line=attrs_node.start_point[0] + 1,
                                        tenant_id=tenant_id,
                                        repo_id=repo_id,
                                    ))
                                break
        return edges

    def _extract_php_call_edges(
        self,
        root: object,
        fn_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Extract CALLS edges for PHP's three call expression types.

        Args:
            root: AST root node.
            fn_nodes: All function LexicalNodes extracted from this file.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of deduplicated calls GraphEdge objects.
        """
        scoped_fns = sorted(
            [fn for fn in fn_nodes if fn.line_end is not None],
            key=lambda n: n.line_start,
        )
        if not scoped_fns:
            return []

        _CALL_TYPES = frozenset({
            "function_call_expression",
            "member_call_expression",
            "scoped_call_expression",
        })

        edges: list[GraphEdge] = []
        seen: set[str] = set()

        for ast_node in _walk(root):
            if ast_node.type not in _CALL_TYPES:
                continue
            call_line = ast_node.start_point[0] + 1

            caller = None
            for fn in scoped_fns:
                if fn.line_start <= call_line <= (fn.line_end or call_line) and (
                    caller is None or fn.line_start > caller.line_start
                ):
                    caller = fn
            if caller is None:
                continue

            callee_name = self._php_callee_name(ast_node)
            if not callee_name or callee_name == caller.name or callee_name in _BUILTIN_NAMES:
                continue

            key = f"{caller.node_id}:{callee_name}"
            if key in seen:
                continue
            seen.add(key)
            edges.append(GraphEdge(
                edge_id=GraphEdge.make_id(caller.node_id, "calls", callee_name),
                edge_type="calls",
                source_id=caller.node_id,
                target_id=callee_name,
                target_name=callee_name,
                file=file_path,
                line=call_line,
                tenant_id=caller.tenant_id,
                repo_id=caller.repo_id,
            ))
        return edges

    def _php_callee_name(self, call_node: object) -> str | None:
        """Extract callee name from a PHP call expression node.

        Args:
            call_node: A PHP call expression AST node.

        Returns:
            Callee name string, or None if unresolvable.
        """
        if call_node.type == "function_call_expression":  # type: ignore[attr-defined]
            fn = call_node.child_by_field_name("function")  # type: ignore[attr-defined]
            if fn and fn.type == "name":
                return str(fn.text.decode())
        elif call_node.type in ("member_call_expression", "scoped_call_expression"):  # type: ignore[attr-defined]
            name_node = call_node.child_by_field_name("name")  # type: ignore[attr-defined]
            if name_node and name_node.type == "name":
                return str(name_node.text.decode())
        return None

    # ------------------------------------------------------------------
    # PROTECTED_BY extraction (Laravel Route::middleware()->group())
    # ------------------------------------------------------------------

    def _extract_php_protected_by(
        self,
        root: object,
        fn_nodes: list[LexicalNode],
        result_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Emit PROTECTED_BY edges for Laravel ``Route::middleware()->group()`` patterns.

        Detects::

            Route::middleware(['auth'])->group(function () {
                Route::get('/profile', [UserController::class, 'index']);
                Route::get('/settings', 'SettingsController@show');
            });

        Walks the method chain on each ``->group()`` call to find
        ``->middleware([...])`` or ``Route::middleware(...)``, then scans the
        group closure for ``Route::get/post/...`` calls and emits
        PROTECTED_BY from each route handler to each middleware.

        Handler references are controller class names (from ``[Cls::class, 'method']``
        or ``'Cls@method'`` syntax). Since controllers live in other files, external
        LexicalNodes are created for them.

        Args:
            root: AST root node.
            fn_nodes: Function LexicalNodes from this file (usually empty in route files).
            result_nodes: All LexicalNodes (mutated in-place with new external nodes).
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of ``protected_by`` GraphEdge objects.
        """
        _ROUTE_HTTP = frozenset({"get", "post", "put", "patch", "delete", "any", "match"})

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
            # Find ->group(closure) calls
            if node.type != "member_call_expression":
                continue
            name_node = node.child_by_field_name("name")
            if name_node is None or name_node.text.decode() != "group":
                continue

            # Walk chain upward to find ->middleware([...]) or Route::middleware(...)
            obj_node = node.child_by_field_name("object")
            middlewares = self._laravel_find_middleware(obj_node)
            if not middlewares:
                continue

            # Scan inside the group closure for Route::get/post/... calls
            args_node = node.child_by_field_name("arguments")
            if args_node is None:
                continue
            for sub in _walk(args_node):
                if sub.type != "scoped_call_expression":
                    continue
                sub_name = sub.child_by_field_name("name")
                if sub_name is None or sub_name.text.decode() not in _ROUTE_HTTP:
                    continue
                handler_name = self._laravel_extract_handler(sub)
                if not handler_name:
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
                        line_start=sub.start_point[0] + 1,
                        line_end=sub.start_point[0] + 1,
                        language="php",
                        tenant_id=tenant_id,
                        repo_id=repo_id,
                    )
                    result_nodes.append(src)
                    fn_name_to_node[handler_name] = src

                for mw in middlewares:
                    _emit(src.node_id, mw, sub.start_point[0] + 1)

        return edges

    def _laravel_find_middleware(self, chain_node: object) -> list[str]:
        """Walk a Laravel method chain to find ``->middleware([...])`` calls.

        Traverses up the chain via ``object`` fields until it finds
        ``->middleware(...)`` or ``Route::middleware(...)``, extracting all
        string arguments (middleware names).

        Args:
            chain_node: Starting AST node in the method chain (object of ``->group()``).

        Returns:
            List of middleware names found in ``->middleware()`` arguments.
        """
        if chain_node is None:
            return []
        middlewares: list[str] = []
        node = chain_node
        while node is not None:
            if node.type == "member_call_expression":  # type: ignore[attr-defined]
                name_n = node.child_by_field_name("name")  # type: ignore[attr-defined]
                if name_n and name_n.text.decode() == "middleware":
                    args = node.child_by_field_name("arguments")  # type: ignore[attr-defined]
                    if args:
                        for child in _walk(args):
                            if child.type == "string":
                                text = child.text.decode().strip("'\"")
                                if text:
                                    middlewares.append(text)
                node = node.child_by_field_name("object")  # type: ignore[attr-defined]
            elif node.type == "scoped_call_expression":  # type: ignore[attr-defined]
                name_n = node.child_by_field_name("name")  # type: ignore[attr-defined]
                if name_n and name_n.text.decode() == "middleware":
                    args = node.child_by_field_name("arguments")  # type: ignore[attr-defined]
                    if args:
                        for child in _walk(args):
                            if child.type == "string":
                                text = child.text.decode().strip("'\"")
                                if text:
                                    middlewares.append(text)
                break
            else:
                break
        return middlewares

    def _laravel_extract_handler(self, route_call: object) -> str | None:
        """Extract a handler class name from a Laravel ``Route::get/post/...`` call.

        Handles two common handler reference styles:

        - Array style: ``[UserController::class, 'method']``  → ``"UserController"``
        - String style: ``'UserController@method'``            → ``"UserController"``

        Args:
            route_call: A ``scoped_call_expression`` AST node.

        Returns:
            Handler class name string, or None if not extractable.
        """
        args_node = route_call.child_by_field_name("arguments")  # type: ignore[attr-defined]
        if args_node is None:
            return None

        # String style: 'ClassName@method' — second string arg after the path
        strings: list[str] = []
        for child in _walk(args_node):
            if child.type == "string":
                text = child.text.decode().strip("'\"")
                if text:
                    strings.append(text)
        # strings[0] is the route path; strings[1] (if any) is the handler string
        for s in strings[1:]:
            if "@" in s:
                return s.split("@")[0]

        # Array style: [ClassName::class, 'method'] — look for a name node that
        # precedes '::class' (class_constant_access_expression)
        for child in _walk(args_node):
            if child.type == "class_constant_access_expression":
                # first child is the class name (name node)
                for inner in child.children:
                    if inner.type == "name":
                        return str(inner.text.decode())

        return None


    # ------------------------------------------------------------------
    # Taint source emission (PHP HTTP input)
    # ------------------------------------------------------------------

    def _extract_php_taint_sources(
        self,
        root: object,
        fn_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> tuple[list[LexicalNode], list[GraphEdge]]:
        """Emit taint-source nodes and CALLS edges for PHP HTTP input patterns.

        Detects four categories of PHP HTTP input access:

        1. **Superglobals** — ``$_GET``, ``$_POST``, ``$_REQUEST``, ``$_FILES``,
           ``$_COOKIE``, ``$_SERVER``.  Any access to these arrays (subscript or
           bare reference) within a function body is treated as a taint source.

        2. **Laravel** — ``$request->input('name')``, ``$request->query()``,
           ``$request->all()``, ``$request->file()``, etc.
           Detected via ``member_call_expression`` where the method name is in
           ``_PHP_LARAVEL_INPUT_METHODS`` and the receiver text ends with
           ``request`` or ``req``.

        3. **Symfony** — ``$request->query->get()``, ``$request->request->get()``,
           ``$request->files->get()``, etc.  Two-level chain: a
           ``member_call_expression`` whose method is ``get`` (or similar) and
           whose receiver is a ``member_access_expression`` with property in
           ``_PHP_SYMFONY_BAGS``.

        4. **PSR-7 / Slim / CodeIgniter 4** — ``$request->getQueryParams()``,
           ``$request->getParsedBody()``, ``$this->request->getGet()``, etc.
           Method names are in ``_PHP_PSR7_METHODS`` and ``_PHP_CI4_METHODS``.

        For each detected access, emits a synthetic ``external`` ``LexicalNode``
        with ``file="php"`` and a ``CALLS`` edge to the tightest enclosing
        function found by line-range containment.

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

        def _find_caller(node_line: int) -> LexicalNode | None:
            caller: LexicalNode | None = None
            for fn in scoped_fns:
                if fn.line_start <= node_line <= (fn.line_end or node_line) and (
                    caller is None or fn.line_start > caller.line_start
                ):
                    caller = fn
            return caller

        def _emit(source_name: str, caller: LexicalNode, line: int) -> None:
            source_id = LexicalNode.make_id(tenant_id, repo_id, "php", source_name, "external")
            if source_id not in seen_nodes:
                seen_nodes.add(source_id)
                nodes.append(LexicalNode(
                    node_id=source_id,
                    node_type="external",
                    name=source_name,
                    file="php",
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

        all_http_methods = _PHP_LARAVEL_INPUT_METHODS | _PHP_PSR7_METHODS | _PHP_CI4_METHODS

        for node in _walk(root):
            node_type: str = node.type

            # ── Section 1: superglobals ($\_GET, $\_POST, etc.) ──────────────
            if node_type in ("variable_name", "name"):
                text = node.text.decode()
                # Superglobals may appear with or without leading $ depending on grammar
                if text in _PHP_SUPERGLOBALS or f"${text}" in _PHP_SUPERGLOBALS:
                    node_line = node.start_point[0] + 1
                    caller = _find_caller(node_line)
                    if caller:
                        src_name = text if text in _PHP_SUPERGLOBALS else f"${text}"
                        _emit(f"php.{src_name}", caller, node_line)

            # ── Section 2 & 4: Laravel / PSR-7 / CI4 method calls ────────────
            elif node_type == "member_call_expression":
                method_node = node.child_by_field_name("name")
                if method_node is None:
                    continue
                method_name = method_node.text.decode()
                if method_name not in all_http_methods:
                    continue
                node_line = node.start_point[0] + 1
                caller = _find_caller(node_line)
                if caller is None:
                    continue
                _emit(f"php.{method_name}", caller, node_line)

            # ── Section 3: Symfony bag access ($request->query->get()) ────────
            # Detected as member_access_expression object of a member_call_expression
            # (already handled above when method_name = "get" etc., but we add
            # specificity by checking that the intermediate property is a Symfony bag)
            elif node_type == "member_access_expression":
                prop_node = node.child_by_field_name("name")
                if prop_node is None:
                    continue
                prop_name = prop_node.text.decode()
                if prop_name not in _PHP_SYMFONY_BAGS:
                    continue
                # Verify the receiver text contains "request"
                obj_node = node.child_by_field_name("object")
                if obj_node is None:
                    continue
                obj_text = obj_node.text.decode().lower()
                if "request" not in obj_text:
                    continue
                node_line = node.start_point[0] + 1
                caller = _find_caller(node_line)
                if caller:
                    _emit(f"php.symfony.{prop_name}", caller, node_line)

        return nodes, edges


from . import register_language  # noqa: E402

register_language("php", PhpParser, frozenset({".php"}))
