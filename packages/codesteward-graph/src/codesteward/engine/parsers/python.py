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


# ===========================================================================
# AST-based Python parser (tree-sitter)
# ===========================================================================


class PythonParser(TreeSitterBase, LanguageParser):
    """Tree-sitter-based Python parser.

    All Python-specific extraction methods are concentrated here. Shared methods
    (_extract_call_edges, _extract_callee_name, _extract_semantic_edges) are
    inherited from TreeSitterBase.
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

        # Semantic data-flow edges
        result.edges.extend(
            self._extract_semantic_edges(fn_nodes, content_bytes, file_path, tenant_id, repo_id)
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
                return child.text.decode()
            if child.type == "attribute":
                attr = child.child_by_field_name("attribute")
                return attr.text.decode() if attr else child.text.decode()
            if child.type == "call":
                fn = child.child_by_field_name("function")
                if fn:
                    if fn.type == "identifier":
                        return fn.text.decode()
                    if fn.type == "attribute":
                        attr = fn.child_by_field_name("attribute")
                        return attr.text.decode() if attr else fn.text.decode()
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
        if fn_node.text.decode() != "Depends":
            return None
        args = value_node.child_by_field_name("arguments")
        if not args:
            return None
        for arg in args.named_children:
            if arg.type == "identifier":
                return arg.text.decode()
            if arg.type == "attribute":
                attr = arg.child_by_field_name("attribute")
                return attr.text.decode() if attr else None
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
            params: list[dict] = []
            for param in params_node.children:
                if param.type in (",", "(", ")", "/", "*"):
                    continue
                p = self._py_param_info(param)
                if p:
                    params.append(p)
            if params:
                fn_node.metadata["parameters"] = params

    def _py_param_info(self, param_node: Any) -> dict | None:
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
