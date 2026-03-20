"""Python parser (tree-sitter AST). Requires ``tree-sitter-python`` (install with ``uv pip install -e '.[graph]'``).
"""


from typing import Any

import structlog

from ._ast_utils import (
    TreeSitterBase,
    _import_edge,
    _walk,
)
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult

log = structlog.get_logger()


# FastAPI parameter types treated as taint sources for L1 analysis.
_FASTAPI_TAINT_SOURCES: frozenset[str] = frozenset(
    {"Query", "Body", "Path", "Form", "Header", "Cookie", "File", "UploadFile"}
)

# Django / Flask ``request`` attribute names treated as taint sources.
_DJANGO_FLASK_REQUEST_ATTRS: frozenset[str] = frozenset(
    {
        # Django QueryDict attributes
        "GET", "POST", "PUT", "PATCH", "DELETE", "FILES",
        # Django request body
        "body", "data",
        # Flask / DRF request properties
        "args", "form", "json", "files", "values", "cookies", "stream",
    }
)

# HTTP method names used in FastAPI route decorators.
_FASTAPI_ROUTE_HTTP_METHODS: frozenset[str] = frozenset(
    {"get", "post", "put", "patch", "delete", "head", "options", "websocket"}
)

# Python types that FastAPI auto-binds as query/path parameters (not Pydantic bodies).
# Any type annotation whose base name is NOT in this set and starts with an uppercase
# letter is assumed to be a Pydantic model and treated as a request body source.
_FASTAPI_IMPLICIT_PRIMITIVE_TYPES: frozenset[str] = frozenset(
    {
        "str", "int", "float", "bool", "bytes", "None",
        "Optional", "Union", "Annotated", "Literal",
        "List", "list", "Tuple", "tuple", "Set", "set",
        "FrozenSet", "frozenset", "Dict", "dict",
        "Sequence", "Iterable", "Iterator",
        "datetime", "date", "time", "timedelta",
        "UUID", "Decimal",
    }
)

# FastAPI special injection types that should never be treated as taint sources,
# even though they appear as plain typed parameters (no Depends wrapper).
_FASTAPI_INJECTION_TYPES: frozenset[str] = frozenset(
    {"Request", "Response", "BackgroundTasks", "WebSocket", "Session", "AsyncSession"}
)


def _path_params_from_route(path_text: str) -> set[str]:
    """Extract path parameter names from a FastAPI route pattern string.

    Handles ``/{param}`` and ``/{param:type}`` (converter) syntax.

    Args:
        path_text: Route path string, e.g. ``"/{egrid}"`` or ``"/{pid}/lock"``.

    Returns:
        Set of parameter name strings.
    """
    params: set[str] = set()
    for segment in path_text.split("/"):
        s = segment.strip()
        if s.startswith("{") and s.endswith("}"):
            params.add(s[1:-1].split(":")[0])
    return params


def _annotation_base_type(type_text: str) -> str:
    """Return the base type name from a Python type annotation string.

    Strips ``Optional[...]``, ``| None`` suffixes, and generic brackets so
    that ``Optional[str]``, ``str | None``, and ``List[str]`` all reduce to
    their outer container name (``str``, ``str``, ``List`` respectively).

    Args:
        type_text: Raw type annotation text, e.g. ``"Optional[str]"``.

    Returns:
        Base type name string, e.g. ``"str"``.
    """
    t = type_text.strip()
    # Unwrap Optional[X] → X
    if t.startswith("Optional[") and t.endswith("]"):
        t = t[9:-1].strip()
    # Strip trailing "| None" or "| None " patterns
    for suffix in (" | None", "| None"):
        if t.endswith(suffix):
            t = t[: -len(suffix)].strip()
    # Strip leading "None | " patterns
    for prefix in ("None | ", "None |"):
        if t.startswith(prefix):
            t = t[len(prefix):].strip()
    # Return the outer type name (before any generic brackets)
    return t.split("[")[0].strip()


# ===========================================================================
# AST-based Python parser (tree-sitter)
# ===========================================================================


class PythonParser(TreeSitterBase, LanguageParser):
    """Tree-sitter-based Python parser.

    All Python-specific extraction methods are concentrated here. Shared methods
    (_extract_call_edges, _extract_callee_name) are inherited from TreeSitterBase.
    """

    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "python",
    ) -> ParseResult:
        """Parse a Python file via tree-sitter.

        Args:
            file_path: Repo-relative path to the file.
            content: Full file content as a string.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Always "python".

        Returns:
            ParseResult with the file node, symbol nodes, and edges.
        """
        parser = self._get_ts_parser("python")
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
            self._extract_py_nodes(root, file_path, tenant_id, repo_id, language)
        )
        result.edges.extend(
            self._extract_py_imports(root, file_node.node_id, file_path, tenant_id, repo_id)
        )

        # CALLS edges
        fn_nodes = [n for n in result.nodes if n.node_type == "function"]
        result.edges.extend(
            self._extract_call_edges(root, fn_nodes, file_path, tenant_id, repo_id, language)
        )

        # EXTENDS edges
        class_nodes = [n for n in result.nodes if n.node_type == "class"]
        result.edges.extend(
            self._extract_py_extends(root, class_nodes, file_path, tenant_id, repo_id)
        )

        # GUARDED_BY edges
        result.edges.extend(
            self._extract_py_guarded_by(root, fn_nodes, result.nodes, file_path, tenant_id, repo_id)
        )

        # PROTECTED_BY edges (FastAPI router scope)
        result.edges.extend(
            self._extract_fastapi_router_protected_by(
                root, fn_nodes, result.nodes, file_path, tenant_id, repo_id
            )
        )

        # Parameter extraction (enriches function node metadata in-place)
        self._extract_py_parameters(root, fn_nodes, language)

        # Python framework taint source nodes and edges
        taint_nodes, taint_edges = self._extract_python_taint_sources(
            root, fn_nodes, file_path, tenant_id, repo_id, language
        )
        result.nodes.extend(taint_nodes)
        result.edges.extend(taint_edges)

        return result

    # ------------------------------------------------------------------
    # Python node extraction
    # ------------------------------------------------------------------

    def _extract_py_nodes(
        self,
        root: Any,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> list[LexicalNode]:
        """Extract lexical nodes from a Python AST.

        Processes top-level module children only (functions, classes).
        Class methods are extracted from class bodies.

        Args:
            root: AST root node (module).
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Always ``"python"``.

        Returns:
            List of ``LexicalNode`` objects.
        """
        nodes: list[LexicalNode] = []
        for child in root.children:
            self._process_py_toplevel(child, file_path, tenant_id, repo_id, language, nodes)
        return nodes

    def _process_py_toplevel(
        self,
        node: Any,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
        out: list[LexicalNode],
    ) -> None:
        """Process a single top-level Python AST node.

        Handles ``function_definition``, ``async_function_definition``,
        ``class_definition``, and ``decorated_definition``.

        Args:
            node: AST node to process.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Source language string.
            out: Output list to append to.
        """
        ntype = node.type

        if ntype in ("function_definition", "async_function_definition"):
            fn = self._py_fn_node(node, file_path, tenant_id, repo_id, language)
            if fn:
                out.append(fn)
            return

        if ntype == "class_definition":
            cls = self._py_class_node(node, file_path, tenant_id, repo_id, language)
            if cls:
                out.append(cls)
            # Extract methods from the class body
            body = node.child_by_field_name("body")
            if body:
                for member in body.children:
                    if member.type in ("function_definition", "async_function_definition"):
                        m = self._py_fn_node(member, file_path, tenant_id, repo_id, language)
                        if m:
                            out.append(m)
                    elif member.type == "decorated_definition":
                        inner = member.child_by_field_name("definition")
                        if inner and inner.type in (
                            "function_definition",
                            "async_function_definition",
                        ):
                            m = self._py_fn_node(inner, file_path, tenant_id, repo_id, language)
                            if m:
                                out.append(m)
            return

        if ntype == "decorated_definition":
            inner = node.child_by_field_name("definition")
            if inner:
                self._process_py_toplevel(inner, file_path, tenant_id, repo_id, language, out)

    def _py_fn_node(
        self,
        node: Any,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> LexicalNode | None:
        """Build a ``LexicalNode`` from a Python ``function_definition`` node."""
        name_node = node.child_by_field_name("name")
        if not name_node:
            return None
        name = name_node.text.decode()
        is_async = node.type == "async_function_definition" or any(
            c.type == "async" for c in node.children
        )
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
            is_async=is_async,
        )

    def _py_class_node(
        self,
        node: Any,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> LexicalNode | None:
        """Build a ``LexicalNode`` from a Python ``class_definition`` node."""
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
        )

    # ------------------------------------------------------------------
    # CALLS edges
    # ------------------------------------------------------------------

    # (inherited from TreeSitterBase._extract_call_edges)

    # ------------------------------------------------------------------
    # EXTENDS edge extraction
    # ------------------------------------------------------------------

    def _extract_py_extends(
        self,
        root: Any,
        class_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Emit EXTENDS edges for Python class inheritance.

        Handles ``class Foo(Bar, Baz):`` — the ``superclasses`` field of a
        ``class_definition`` node is an ``argument_list`` whose children are
        the base class expressions (identifiers or attribute access).

        Args:
            root: AST root node.
            class_nodes: Class LexicalNodes extracted from this file.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of ``extends`` ``GraphEdge`` objects.
        """
        name_to_node = {n.name: n for n in class_nodes}
        edges: list[GraphEdge] = []
        seen: set[str] = set()

        for node in _walk(root):
            if node.type != "class_definition":
                continue
            name_node = node.child_by_field_name("name")
            if not name_node:
                continue
            src = name_to_node.get(name_node.text.decode())
            if not src:
                continue
            superclasses = node.child_by_field_name("superclasses")
            if not superclasses:
                continue
            for child in superclasses.children:
                base: str | None = None
                if child.type == "identifier":
                    base = child.text.decode()
                elif child.type == "attribute":
                    # e.g. module.BaseClass — use the attribute (rightmost) name
                    attr = child.child_by_field_name("attribute")
                    base = attr.text.decode() if attr else None
                if base and base not in ("object",):
                    key = f"{src.node_id}:{base}"
                    if key not in seen:
                        seen.add(key)
                        edges.append(GraphEdge(
                            edge_id=GraphEdge.make_id(src.node_id, "extends", base),
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
    # GUARDED_BY edge extraction
    # ------------------------------------------------------------------

    def _extract_py_guarded_by(
        self,
        root: Any,
        fn_nodes: list[LexicalNode],
        result_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Extract GUARDED_BY edges for Python decorators and FastAPI Depends().

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

        # Pattern 1: decorated_definition → emit GUARDED_BY per decorator
        for node in _walk(root):
            if node.type != "decorated_definition":
                continue
            inner = node.child_by_field_name("definition")
            if not inner:
                continue
            name_node = inner.child_by_field_name("name")
            if not name_node:
                continue
            node_type = "class" if inner.type == "class_definition" else "function"
            source_id = LexicalNode.make_id(
                tenant_id, repo_id, file_path, name_node.text.decode(), node_type
            )
            for child in node.children:
                if child.type == "decorator":
                    guard_name = self._py_decorator_name(child)
                    if guard_name:
                        _emit(source_id, guard_name, child.start_point[0] + 1)

        # Pattern 2: FastAPI Depends() in any function signature
        for node in _walk(root):
            if node.type not in ("function_definition", "async_function_definition"):
                continue
            name_node = node.child_by_field_name("name")
            if not name_node:
                continue
            source_id = LexicalNode.make_id(
                tenant_id, repo_id, file_path, name_node.text.decode(), "function"
            )
            params_node = node.child_by_field_name("parameters")
            if not params_node:
                continue
            for param in params_node.children:
                if param.type != "typed_default_parameter":
                    continue
                dep_target = self._py_depends_target(param)
                if dep_target:
                    _emit(source_id, dep_target, param.start_point[0] + 1)

        return edges

    def _py_decorator_name(self, decorator_node: Any) -> str | None:
        """Extract the name from a Python ``decorator`` AST node.

        Handles plain identifiers (``@login_required``), attribute access
        (``@module.decorator``), and call expressions (``@requires_role('admin')``).

        Args:
            decorator_node: A tree-sitter ``decorator`` node.

        Returns:
            Decorator name string, or ``None`` if unresolvable.
        """
        for child in decorator_node.children:
            if child.type == "identifier":
                return str(child.text.decode())
            if child.type == "attribute":
                attr = child.child_by_field_name("attribute")
                return str(attr.text.decode()) if attr else str(child.text.decode())
            if child.type == "call":
                fn = child.child_by_field_name("function")
                if fn:
                    if fn.type == "identifier":
                        return str(fn.text.decode())
                    if fn.type == "attribute":
                        attr = fn.child_by_field_name("attribute")
                        return str(attr.text.decode()) if attr else str(fn.text.decode())
        return None

    def _py_depends_target(self, param_node: Any) -> str | None:
        """Extract the inner function name from a FastAPI ``Depends(fn)`` parameter.

        Matches ``typed_default_parameter`` nodes whose default value is a
        ``call`` to ``Depends`` and returns the name of the injected function.

        Args:
            param_node: A tree-sitter ``typed_default_parameter`` node.

        Returns:
            Dependency function name, or ``None`` if not a ``Depends`` call.
        """
        value_node = param_node.child_by_field_name("value")
        if not value_node or value_node.type != "call":
            return None
        fn_node = value_node.child_by_field_name("function")
        if not fn_node or fn_node.type != "identifier":
            return None
        if str(fn_node.text.decode()) != "Depends":
            return None
        args = value_node.child_by_field_name("arguments")
        if not args:
            return None
        for arg in args.named_children:
            if arg.type == "identifier":
                return str(arg.text.decode())
            if arg.type == "attribute":
                attr = arg.child_by_field_name("attribute")
                return str(attr.text.decode()) if attr else None
        return None

    # ------------------------------------------------------------------
    # PROTECTED_BY edge extraction (FastAPI router scope)
    # ------------------------------------------------------------------

    def _extract_fastapi_router_protected_by(
        self,
        root: Any,
        fn_nodes: list[LexicalNode],
        result_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Emit PROTECTED_BY edges for FastAPI ``APIRouter(dependencies=[Depends(fn)])``.

        Detects the pattern::

            router = APIRouter(dependencies=[Depends(get_auth_context)])

            @router.get("/profile")
            async def read_profile(): ...

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

        _ROUTE_METHODS = frozenset(
            ["get", "post", "put", "patch", "delete", "head", "options", "websocket"]
        )

        # ── Pass 1: find APIRouter(dependencies=[Depends(fn), ...]) ─────────
        # {variable_name → [dependency_fn_name, ...]}
        router_deps: dict[str, list[str]] = {}

        for node in _walk(root):
            if node.type != "assignment":
                continue
            lhs = node.child_by_field_name("left")
            rhs = node.child_by_field_name("right")
            if not lhs or not rhs or lhs.type != "identifier":
                continue
            if rhs.type != "call":
                continue
            fn_node = rhs.child_by_field_name("function")
            if not fn_node or fn_node.text.decode() not in ("APIRouter", "Router"):
                continue
            var_name = lhs.text.decode()

            args = rhs.child_by_field_name("arguments")
            if not args:
                continue
            for kw in _walk(args):
                if kw.type != "keyword_argument":
                    continue
                kw_name = kw.child_by_field_name("name")
                kw_val = kw.child_by_field_name("value")
                if not kw_name or kw_name.text.decode() != "dependencies":
                    continue
                if not kw_val:
                    continue
                for item in _walk(kw_val):
                    if item.type != "call":
                        continue
                    item_fn = item.child_by_field_name("function")
                    if not item_fn or item_fn.text.decode() != "Depends":
                        continue
                    item_args = item.child_by_field_name("arguments")
                    if not item_args:
                        continue
                    for arg in item_args.children:
                        if arg.type == "identifier":
                            router_deps.setdefault(var_name, []).append(
                                arg.text.decode()
                            )
                            break

        if not router_deps:
            return edges

        # Build name→node_id map
        fn_id_by_name: dict[str, str] = {n.name: n.node_id for n in fn_nodes}

        # ── Pass 2: match @{router_var}.{method}(...) decorators ─────────────
        for node in _walk(root):
            if node.type != "decorated_definition":
                continue
            fn_def = None
            decorators: list[Any] = []
            for child in node.children:
                if child.type == "decorator":
                    decorators.append(child)
                elif child.type in ("function_definition", "async_function_definition"):
                    fn_def = child
            if not fn_def or not decorators:
                continue
            fn_name_node = fn_def.child_by_field_name("name")
            if not fn_name_node:
                continue
            fn_name = fn_name_node.text.decode()
            source_id = fn_id_by_name.get(fn_name) or LexicalNode.make_id(
                tenant_id, repo_id, file_path, fn_name, "function"
            )

            for dec in decorators:
                for child in dec.children:
                    if child.type != "call":
                        continue
                    dec_fn = child.child_by_field_name("function")
                    if not dec_fn or dec_fn.type != "attribute":
                        continue
                    attr_obj = dec_fn.child_by_field_name("object")
                    attr_prop = dec_fn.child_by_field_name("attribute")
                    if not attr_obj or not attr_prop:
                        continue
                    var_name = attr_obj.text.decode()
                    method_name = attr_prop.text.decode()
                    if method_name not in _ROUTE_METHODS:
                        continue
                    if var_name not in router_deps:
                        continue
                    for dep_fn in router_deps[var_name]:
                        _emit(source_id, dep_fn, dec.start_point[0] + 1)

        return edges

    # ------------------------------------------------------------------
    # Parameter extraction (enriches function node metadata in-place)
    # ------------------------------------------------------------------

    def _extract_py_parameters(
        self, root: Any, fn_nodes: list[LexicalNode], language: str
    ) -> None:
        """Populate ``metadata['parameters']`` for Python function nodes.

        Args:
            root: AST root node.
            fn_nodes: Function LexicalNodes to enrich (modified in-place).
            language: Always "python".
        """
        fn_by_line: dict[int, LexicalNode] = {n.line_start: n for n in fn_nodes}

        for node in _walk(root):
            if node.type not in ("function_definition", "async_function_definition"):
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
                if param.type in (",", "(", ")", "/", "*"):
                    continue
                p = self._py_param_info(param)
                if p:
                    params.append(p)
            if params:
                fn_node.metadata["parameters"] = params

    def _py_param_info(self, param_node: Any) -> dict[str, Any] | None:
        """Extract name and type annotation from a Python parameter AST node.

        Args:
            param_node: A tree-sitter parameter node.

        Returns:
            Dict with ``name`` and ``type`` keys, or ``None``.
        """
        if param_node.type == "typed_parameter":
            name_node = param_node.child_by_field_name("name") or (
                param_node.children[0] if param_node.children else None
            )
            type_node = param_node.child_by_field_name("type")
            name = name_node.text.decode() if name_node else None
            type_text = type_node.text.decode() if type_node else None
            return {"name": name, "type": type_text} if name else None
        if param_node.type == "typed_default_parameter":
            name_node = param_node.child_by_field_name("name")
            type_node = param_node.child_by_field_name("type")
            name = name_node.text.decode() if name_node else None
            type_text = type_node.text.decode() if type_node else None
            return {"name": name, "type": type_text} if name else None
        if param_node.type == "identifier":
            text = param_node.text.decode()
            if text in ("self", "cls"):
                return None
            return {"name": text, "type": None}
        if param_node.type == "default_parameter":
            name_node = param_node.child_by_field_name("name")
            name = name_node.text.decode() if name_node else None
            return {"name": name, "type": None} if name else None
        if param_node.type in ("list_splat_pattern", "dictionary_splat_pattern"):
            inner = param_node.children[-1] if param_node.children else None
            prefix = "**" if param_node.type == "dictionary_splat_pattern" else "*"
            name = f"{prefix}{inner.text.decode()}" if inner else f"{prefix}args"
            return {"name": name, "type": None}
        return None

    # ------------------------------------------------------------------
    # Python web framework taint source emission
    # ------------------------------------------------------------------

    def _extract_python_taint_sources(
        self,
        root: Any,
        fn_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> tuple[list[LexicalNode], list[GraphEdge]]:
        """Emit taint-source nodes and CALLS edges for Python web framework inputs.

        Covers three source patterns across the major Python web frameworks:

        **FastAPI** — ``typed_default_parameter`` defaults that call a source
        type (``Query``, ``Body``, ``Path``, ``Form``, ``Header``, ``Cookie``,
        ``File``, ``UploadFile``).  Also handles the ``fastapi.Query(...)``
        attribute form.  Emits source nodes with ``file="fastapi"``.

        **Django** — attribute access on ``request``:
        ``request.GET``, ``request.POST``, ``request.FILES``, ``request.body``,
        ``request.data``, etc.  Emits source nodes with ``file="django_flask"``
        and name ``request.<attr>``.

        **Flask / DRF** — attribute access on ``request``:
        ``request.args``, ``request.form``, ``request.json``,
        ``request.files``, ``request.values``, ``request.cookies``, etc.
        Emits source nodes with ``file="django_flask"`` and name
        ``request.<attr>``.

        For each detected source usage, emits:

        - A synthetic external ``LexicalNode`` for the source (deduped).
        - A ``CALLS`` edge **from** the source node **to** the enclosing
          handler function — e.g. ``(Query) -[:CALLS]-> (get_user)``.

        This reverse-direction edge enables L1 taint traversal:
        ``(Query) → (get_user) → (execute)``.

        Args:
            root: AST root node.
            fn_nodes: Function LexicalNodes from this file.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Always ``"python"``.

        Returns:
            Tuple of ``(nodes, edges)`` — synthetic source LexicalNodes and
            CALLS edges pointing from each source to its handler.
        """
        nodes: list[LexicalNode] = []
        edges: list[GraphEdge] = []
        seen_nodes: set[str] = set()
        seen_edges: set[str] = set()

        fn_id_by_name: dict[str, str] = {n.name: n.node_id for n in fn_nodes}
        # Sorted for line-range containment (Django/Flask detection)
        scoped_fns = sorted(
            [fn for fn in fn_nodes if fn.line_end is not None],
            key=lambda n: n.line_start,
        )

        def _emit(source_name: str, source_file: str, handler_id: str, handler_name: str, line: int) -> None:
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
                    language=language,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))
            edge_key = f"{source_id}:{handler_id}"
            if edge_key not in seen_edges:
                seen_edges.add(edge_key)
                edges.append(GraphEdge(
                    edge_id=GraphEdge.make_id(source_id, "calls", handler_name),
                    edge_type="calls",
                    source_id=source_id,
                    target_id=handler_id,
                    target_name=handler_name,
                    file=file_path,
                    line=line,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))

        # ── FastAPI: Query(...), Body(...), etc. as typed_default_parameter defaults ──

        for node in _walk(root):
            if node.type not in ("function_definition", "async_function_definition"):
                continue
            name_node = node.child_by_field_name("name")
            if not name_node:
                continue
            fn_name = name_node.text.decode()
            handler_id = fn_id_by_name.get(fn_name) or LexicalNode.make_id(
                tenant_id, repo_id, file_path, fn_name, "function"
            )
            params_node = node.child_by_field_name("parameters")
            if not params_node:
                continue
            for param in params_node.children:
                if param.type != "typed_default_parameter":
                    continue
                value_node = param.child_by_field_name("value")
                if not value_node or value_node.type != "call":
                    continue
                fn_call = value_node.child_by_field_name("function")
                if not fn_call:
                    continue
                # Handle Query(...) and fastapi.Query(...)
                source_name: str | None = None
                if fn_call.type == "identifier":
                    candidate = fn_call.text.decode()
                    if candidate in _FASTAPI_TAINT_SOURCES:
                        source_name = candidate
                elif fn_call.type == "attribute":
                    attr = fn_call.child_by_field_name("attribute")
                    if attr and attr.text.decode() in _FASTAPI_TAINT_SOURCES:
                        source_name = attr.text.decode()
                if source_name:
                    _emit(source_name, "fastapi", handler_id, fn_name, node.start_point[0] + 1)

        # ── Django / Flask: request.GET, request.form, request.args, etc. ──────────

        for node in _walk(root):
            if node.type != "attribute":
                continue
            obj_node = node.child_by_field_name("object")
            attr_node = node.child_by_field_name("attribute")
            if not obj_node or not attr_node:
                continue
            if obj_node.type != "identifier" or obj_node.text.decode() != "request":
                continue
            attr_name = attr_node.text.decode()
            if attr_name not in _DJANGO_FLASK_REQUEST_ATTRS:
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
            _emit(f"request.{attr_name}", "django_flask", caller.node_id, caller.name, node_line)

        # ── FastAPI implicit params: plain typed args on route handler functions ──────
        #
        # FastAPI does not require Query(...)/Body(...)/Path(...) wrappers — plain
        # typed function arguments on route handlers are automatically bound by FastAPI:
        #   - Name appears in route path template /{param} → Path source
        #   - Primitive type annotation → Query source
        #   - Pydantic model type annotation (PascalCase, non-primitive) → Body source
        #   - Default is Depends(...) → skip (dependency injection, not user input)
        #   - Default is an explicit FastAPI type (Query/Body/...) → skip (handled above)

        for node in _walk(root):
            if node.type != "decorated_definition":
                continue
            inner = node.child_by_field_name("definition")
            if not inner or inner.type not in ("function_definition", "async_function_definition"):
                continue

            # Collect route paths from all route-method decorators on this function
            route_paths: list[str] = []
            for child in node.children:
                if child.type != "decorator":
                    continue
                for dec_child in child.children:
                    if dec_child.type != "call":
                        continue
                    dec_fn = dec_child.child_by_field_name("function")
                    if not dec_fn or dec_fn.type != "attribute":
                        continue
                    method_attr = dec_fn.child_by_field_name("attribute")
                    if not method_attr or method_attr.text.decode() not in _FASTAPI_ROUTE_HTTP_METHODS:
                        continue
                    dec_args = dec_child.child_by_field_name("arguments")
                    if not dec_args:
                        continue
                    for arg in dec_args.children:
                        if arg.type == "string":
                            route_paths.append(arg.text.decode().strip().strip("'\""))
                            break

            if not route_paths:
                continue

            # Collect path param names from the route template(s)
            path_param_names: set[str] = set()
            for rp in route_paths:
                path_param_names.update(_path_params_from_route(rp))

            fn_name_node = inner.child_by_field_name("name")
            if not fn_name_node:
                continue
            fn_name = fn_name_node.text.decode()
            handler_id = fn_id_by_name.get(fn_name) or LexicalNode.make_id(
                tenant_id, repo_id, file_path, fn_name, "function"
            )
            fn_line = inner.start_point[0] + 1

            params_node = inner.child_by_field_name("parameters")
            if not params_node:
                continue

            for param in params_node.children:
                param_name: str | None = None
                type_ann: str | None = None
                skip = False

                if param.type == "typed_parameter":
                    # name: Type  (no default — never a Depends injection)
                    name_n = param.child_by_field_name("name") or (
                        param.children[0] if param.children else None
                    )
                    type_n = param.child_by_field_name("type")
                    param_name = name_n.text.decode() if name_n else None
                    type_ann = type_n.text.decode() if type_n else None

                elif param.type == "typed_default_parameter":
                    # name: Type = default
                    name_n = param.child_by_field_name("name")
                    type_n = param.child_by_field_name("type")
                    val_n = param.child_by_field_name("value")
                    param_name = name_n.text.decode() if name_n else None
                    type_ann = type_n.text.decode() if type_n else None
                    if val_n and val_n.type == "call":
                        dep_fn = val_n.child_by_field_name("function")
                        if dep_fn and dep_fn.type == "identifier":
                            callee = dep_fn.text.decode()
                            if callee == "Depends":
                                skip = True  # dependency injection
                            elif callee in _FASTAPI_TAINT_SOURCES:
                                skip = True  # explicit FastAPI type, handled above

                else:
                    continue

                if skip or not param_name:
                    continue
                if param_name in ("self", "cls"):
                    continue

                # Determine source type
                if param_name in path_param_names:
                    source_name = "Path"
                elif type_ann is None:
                    source_name = "Query"
                else:
                    base = _annotation_base_type(type_ann)
                    if base in _FASTAPI_INJECTION_TYPES:
                        continue  # FastAPI special injection — not user input
                    if base in _FASTAPI_IMPLICIT_PRIMITIVE_TYPES:
                        source_name = "Query"
                    elif base and base[0].isupper():
                        source_name = "Body"  # Pydantic model → request body
                    else:
                        source_name = "Query"  # lowercase type, treat as scalar

                _emit(source_name, "fastapi", handler_id, fn_name, fn_line)

        return nodes, edges

    # ------------------------------------------------------------------
    # Python import edge extraction
    # ------------------------------------------------------------------

    def _extract_py_imports(
        self,
        root: Any,
        file_node_id: str,
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Extract import edges from a Python AST.

        Handles ``import X`` and ``from X import Y`` statements.

        Args:
            root: AST root node (module).
            file_node_id: ID of the file ``LexicalNode`` (edge source).
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of ``GraphEdge`` objects with ``edge_type="imports"``.
        """
        edges: list[GraphEdge] = []
        for node in _walk(root):
            if node.type == "import_statement":
                # import os / import os as o / import os, sys
                for name_node in node.named_children:
                    if name_node.type == "dotted_name":
                        module = name_node.text.decode()
                        edges.append(_import_edge(file_node_id, module, file_path, node, tenant_id, repo_id))
                    elif name_node.type == "aliased_import":
                        inner = name_node.child_by_field_name("name")
                        if inner:
                            module = inner.text.decode()
                            edges.append(_import_edge(file_node_id, module, file_path, node, tenant_id, repo_id))

            elif node.type == "import_from_statement":
                # from pathlib import Path / from . import foo
                mod_node = node.child_by_field_name("module_name")
                if mod_node:
                    module = mod_node.text.decode()
                    edges.append(_import_edge(file_node_id, module, file_path, node, tenant_id, repo_id))

        return edges
